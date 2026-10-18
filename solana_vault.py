"""On-chain group vaults on Solana (devnet): a public, tamper-proof record of who put
what into each shared goal.

The idea
--------
Nessie (Capital One's mock bank) still moves the dollars: adding money to a goal is a
real withdrawal from your checking account. What used to be a vague "escrow" is now a
vault on Solana that anyone can inspect:

  - The app runs a token, "Gatorstar Savings Dollar" (GSD, 2 decimals: 1 GSD = $1.00,
    so token units are cents). Only the app can create it, and only to mirror dollars
    that actually left someone's bank account.
  - Every user gets an app-managed Solana wallet; every goal gets its own vault wallet.
  - A $50 contribution = ONE Solana transaction that mints 50 GSD to your wallet,
    moves it into the goal's vault, and attaches a memo (goal, contribution, Nessie ID).
  - Undoing it moves the GSD back out of the vault to you and burns it, again on-chain.
  - So the vault's token balance IS the pot, and each person's deposits are their
    provable share. Anyone can check it on Solana Explorer.

Reliability: the bank side never waits for the blockchain. Each on-chain step is queued
(table chain_ops) and a background worker sends and confirms it, retrying if Solana is
slow. If Solana is down, contributions still work and show "pending on-chain".

Network: devnet = Solana's free public test network (test SOL, no real money).
Setup (all optional; defaults work locally):
  SOLANA_RPC_URL          default https://api.devnet.solana.com
  SOLANA_AUTHORITY_SECRET the app's wallet (pays the tiny fees, owns the token).
                          If unset, one is created in the data folder. On Railway, set it
                          so it survives redeploys (GET /api/solana/status shows how).
  SOLANA_ENABLED=0        turn the whole thing off.
Fees: each transaction costs a fraction of a cent of TEST SOL. The app asks the devnet
faucet for test SOL automatically; if the faucet is busy, fund the address shown in
the status at https://faucet.solana.com.

Hackathon shortcut, stated plainly: wallet keys are kept in app.db (custodial, like most
fintech apps). A production version would keep them in a key vault / HSM.
"""
from __future__ import annotations

import base64
import json
import os
import struct
import threading
import time

import requests

import db

ENABLED = os.getenv("SOLANA_ENABLED", "1") != "0"
MISSING_LIBRARY = None
try:
    from solders.hash import Hash
    from solders.instruction import AccountMeta, Instruction
    from solders.keypair import Keypair
    from solders.message import Message
    from solders.pubkey import Pubkey
    from solders.system_program import CreateAccountParams, create_account
    from solders.transaction import Transaction
except ImportError:  # the app still runs; vaults are just off until it's installed
    MISSING_LIBRARY = "The 'solders' package isn't installed. Run: venv\\Scripts\\pip install -r requirements.txt"
    ENABLED = False
    print(f"Solana vaults are off: {MISSING_LIBRARY}")
RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
CLUSTER = "devnet" if "devnet" in RPC_URL else "testnet" if "testnet" in RPC_URL else "custom"
EXPLORER = "https://explorer.solana.com"

if MISSING_LIBRARY is None:
    TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    ATA_PROGRAM = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    MEMO_PROGRAM = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    SYSTEM_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")
DECIMALS = 2                     # token units are cents
MINT_SPACE = 82
LAMPORTS_PER_SOL = 1_000_000_000
MIN_FEE_BALANCE = 20_000_000     # 0.02 test SOL: plenty for many transactions
CONFIRM_TIMEOUT = 90             # seconds before a sent transaction is retried
WORKER_INTERVAL = 2.0

_session = requests.Session()
_lock = threading.Lock()         # one worker step at a time
_state = {"state": "starting", "error": None, "sol_balance": None, "last_airdrop_try": 0.0}


# ---------- Database ----------

def init_tables():
    with db.connect() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS solana_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- App-managed wallets: one per user ('user') and one vault per goal ('goal').
        CREATE TABLE IF NOT EXISTS solana_wallets (
            owner_kind TEXT NOT NULL, owner_id INTEGER NOT NULL,
            pubkey TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY (owner_kind, owner_id)
        );
        -- Queue of on-chain steps. kind: deposit | refund.
        -- status: pending -> sent -> confirmed (or failed / cancelled).
        CREATE TABLE IF NOT EXISTS chain_ops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL, goal_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
            contribution_id INTEGER, amount_cents INTEGER NOT NULL, memo TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', signature TEXT, error TEXT,
            attempts INTEGER NOT NULL DEFAULT 0, sent_at REAL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chain_ops_status ON chain_ops (status, id);
        CREATE INDEX IF NOT EXISTS chain_ops_goal ON chain_ops (goal_id);
        """)


init_tables()


def _config(key: str, value: str | None = None) -> str | None:
    with db.connect() as conn:
        if value is not None:
            conn.execute("INSERT INTO solana_config (key, value) VALUES (?, ?) "
                         "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, value))
            return value
        row = conn.execute("SELECT value FROM solana_config WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None


# ---------- Keys ----------

def _keypair_from_secret(text: str) -> Keypair:
    text = text.strip()
    if text.startswith("["):
        return Keypair.from_bytes(bytes(json.loads(text)))
    return Keypair.from_base58_string(text)


def authority() -> Keypair:
    """The app's own wallet: pays fees and is the only one allowed to create GSD."""
    secret = os.getenv("SOLANA_AUTHORITY_SECRET")
    if secret:
        return _keypair_from_secret(secret)
    path = db.DATA_DIR / "solana_authority.json"
    if not path.exists():
        path.write_text(json.dumps(list(bytes(Keypair()))))
        print(f"Created a Solana devnet wallet for the app in {path.name}.")
    return Keypair.from_bytes(bytes(json.loads(path.read_text())))


def wallet(kind: str, owner_id: int) -> Keypair:
    """The app-managed wallet for a user ('user') or a goal's vault ('goal'), created on first use."""
    with db.connect() as conn:
        row = conn.execute("SELECT secret FROM solana_wallets WHERE owner_kind = ? AND owner_id = ?",
                           (kind, owner_id)).fetchone()
        if row:
            return Keypair.from_base58_string(row["secret"])
        kp = Keypair()
        conn.execute("INSERT INTO solana_wallets (owner_kind, owner_id, pubkey, secret, created_at) VALUES (?, ?, ?, ?, ?)",
                     (kind, owner_id, str(kp.pubkey()), str(kp), db.now()))
        return kp


def wallet_address(kind: str, owner_id: int) -> str | None:
    with db.connect() as conn:
        row = conn.execute("SELECT pubkey FROM solana_wallets WHERE owner_kind = ? AND owner_id = ?",
                           (kind, owner_id)).fetchone()
    return row["pubkey"] if row else None


def token_account(owner: Pubkey, mint: Pubkey) -> Pubkey:
    """The owner's GSD account (its 'associated token account')."""
    return Pubkey.find_program_address([bytes(owner), bytes(TOKEN_PROGRAM), bytes(mint)], ATA_PROGRAM)[0]


# ---------- Instructions (SPL Token, Associated Token Account, Memo) ----------

def ix_create_token_account(payer: Pubkey, owner: Pubkey, mint: Pubkey) -> Instruction:
    """Create the owner's GSD account if it doesn't exist yet (idempotent)."""
    return Instruction(ATA_PROGRAM, bytes([1]), [
        AccountMeta(payer, True, True), AccountMeta(token_account(owner, mint), False, True),
        AccountMeta(owner, False, False), AccountMeta(mint, False, False),
        AccountMeta(SYSTEM_PROGRAM, False, False), AccountMeta(TOKEN_PROGRAM, False, False),
    ])


def ix_init_mint(mint: Pubkey, mint_authority: Pubkey) -> Instruction:
    # InitializeMint2 (20): decimals, mint authority, no freeze authority
    return Instruction(TOKEN_PROGRAM, bytes([20, DECIMALS]) + bytes(mint_authority) + bytes([0]),
                       [AccountMeta(mint, False, True)])


def ix_mint_to(mint: Pubkey, dest: Pubkey, mint_authority: Pubkey, amount: int) -> Instruction:
    return Instruction(TOKEN_PROGRAM, bytes([7]) + struct.pack("<Q", amount), [
        AccountMeta(mint, False, True), AccountMeta(dest, False, True), AccountMeta(mint_authority, True, False)])


def ix_transfer(source: Pubkey, mint: Pubkey, dest: Pubkey, owner: Pubkey, amount: int) -> Instruction:
    # TransferChecked (12)
    return Instruction(TOKEN_PROGRAM, bytes([12]) + struct.pack("<Q", amount) + bytes([DECIMALS]), [
        AccountMeta(source, False, True), AccountMeta(mint, False, False),
        AccountMeta(dest, False, True), AccountMeta(owner, True, False)])


def ix_burn(account: Pubkey, mint: Pubkey, owner: Pubkey, amount: int) -> Instruction:
    # BurnChecked (15)
    return Instruction(TOKEN_PROGRAM, bytes([15]) + struct.pack("<Q", amount) + bytes([DECIMALS]), [
        AccountMeta(account, False, True), AccountMeta(mint, False, True), AccountMeta(owner, True, False)])


def ix_memo(text: str) -> Instruction:
    return Instruction(MEMO_PROGRAM, text.encode()[:500], [])


def build_tx(instructions: list, signers: list[Keypair], blockhash: Hash) -> Transaction:
    """Signed transaction; the first signer (the app authority) pays the fees."""
    message = Message.new_with_blockhash(instructions, signers[0].pubkey(), blockhash)
    return Transaction(signers, message, blockhash)


def deposit_tx(auth: Keypair, member: Keypair, vault: Keypair, mint: Pubkey, cents: int, memo: str, blockhash: Hash) -> Transaction:
    """Mint GSD to the member for dollars that left their bank, then move it into the vault."""
    m_acct, v_acct = token_account(member.pubkey(), mint), token_account(vault.pubkey(), mint)
    return build_tx([
        ix_create_token_account(auth.pubkey(), member.pubkey(), mint),
        ix_create_token_account(auth.pubkey(), vault.pubkey(), mint),
        ix_mint_to(mint, m_acct, auth.pubkey(), cents),
        ix_transfer(m_acct, mint, v_acct, member.pubkey(), cents),
        ix_memo(memo),
    ], [auth, member], blockhash)


def refund_tx(auth: Keypair, member: Keypair, vault: Keypair, mint: Pubkey, cents: int, memo: str, blockhash: Hash) -> Transaction:
    """Move GSD back out of the vault to the member and burn it (the dollars went back to their bank)."""
    m_acct, v_acct = token_account(member.pubkey(), mint), token_account(vault.pubkey(), mint)
    return build_tx([
        ix_create_token_account(auth.pubkey(), member.pubkey(), mint),
        ix_transfer(v_acct, mint, m_acct, vault.pubkey(), cents),
        ix_burn(m_acct, mint, member.pubkey(), cents),
        ix_memo(memo),
    ], [auth, vault, member], blockhash)


# ---------- Talking to Solana (JSON-RPC) ----------

class ChainError(Exception):
    pass


def rpc(method: str, params: list | None = None):
    try:
        r = _session.post(RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}, timeout=15)
    except requests.RequestException as e:
        raise ChainError(f"Can't reach Solana ({RPC_URL}): {e.__class__.__name__}")
    if r.status_code == 429:
        raise ChainError("Solana devnet is rate-limiting requests; will retry")
    try:
        body = r.json()
    except ValueError:
        raise ChainError(f"Solana answered {r.status_code}")
    if "error" in body:
        raise ChainError(str(body["error"].get("message", body["error"]))[:200])
    return body["result"]


def send(tx: Transaction) -> str:
    raw = base64.b64encode(bytes(tx)).decode()
    return rpc("sendTransaction", [raw, {"encoding": "base64", "preflightCommitment": "confirmed"}])


def _blockhash() -> Hash:
    return Hash.from_string(rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"])


def _sol_balance(pubkey: Pubkey) -> int:
    return rpc("getBalance", [str(pubkey), {"commitment": "confirmed"}])["value"]


def token_balance(owner: str, mint: str) -> int:
    """Token units (cents) held by an owner; 0 if their token account doesn't exist yet."""
    try:
        v = rpc("getTokenAccountBalance", [str(token_account(Pubkey.from_string(owner), Pubkey.from_string(mint))),
                                           {"commitment": "confirmed"}])
        return int(v["value"]["amount"])
    except ChainError as e:
        if "could not find account" in str(e).lower() or "invalid param" in str(e).lower():
            return 0
        raise


# ---------- Setup: fee money + the GSD token ----------

def _ensure_funded(auth: Keypair) -> bool:
    lamports = _sol_balance(auth.pubkey())
    _state["sol_balance"] = lamports / LAMPORTS_PER_SOL
    if lamports >= MIN_FEE_BALANCE:
        return True
    if time.time() - _state["last_airdrop_try"] > 300:   # don't hammer the faucet
        _state["last_airdrop_try"] = time.time()
        try:
            rpc("requestAirdrop", [str(auth.pubkey()), LAMPORTS_PER_SOL])
            print("Asked the Solana devnet faucet for 1 test SOL for fees.")
        except ChainError as e:
            print(f"Solana devnet faucet said no ({e}). Fund {auth.pubkey()} at https://faucet.solana.com")
    _state.update(state="needs_funding", error=f"The app wallet needs test SOL for fees. Fund {auth.pubkey()} at https://faucet.solana.com (devnet).")
    return False


def ensure_mint(auth: Keypair) -> Pubkey:
    """Create the GSD token once (per app wallet) and remember its address."""
    saved, owner = _config("mint"), _config("mint_authority")
    if saved and owner == str(auth.pubkey()):
        return Pubkey.from_string(saved)
    mint = Keypair()
    rent = rpc("getMinimumBalanceForRentExemption", [MINT_SPACE])
    tx = build_tx([
        create_account(CreateAccountParams(from_pubkey=auth.pubkey(), to_pubkey=mint.pubkey(), lamports=rent,
                                           space=MINT_SPACE, owner=TOKEN_PROGRAM)),
        ix_init_mint(mint.pubkey(), auth.pubkey()),
        ix_memo("Gatorstar Savings Dollar (GSD): 1 GSD = $1 saved toward a Gatorstar group goal"),
    ], [auth, mint], _blockhash())
    sig = send(tx)
    if not _wait_confirmed(sig, 45):
        raise ChainError("Creating the GSD token didn't confirm yet; will retry")
    _config("mint", str(mint.pubkey()))
    _config("mint_authority", str(auth.pubkey()))
    print(f"Created the GSD token on Solana {CLUSTER}: {mint.pubkey()}")
    return mint.pubkey()


def _statuses(sigs: list[str]) -> list:
    return rpc("getSignatureStatuses", [sigs, {"searchTransactionHistory": True}])["value"]


def _wait_confirmed(sig: str, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        s = _statuses([sig])[0]
        if s and s.get("err"):
            raise ChainError(f"Transaction failed: {s['err']}")
        if s and s.get("confirmationStatus") in ("confirmed", "finalized"):
            return True
        time.sleep(1.5)
    return False


# ---------- The queue ----------

def _now():
    return db.now()


def enqueue_deposit(contribution_id: int, goal_id: int, user_id: int, cents: int, memo: str):
    if not ENABLED:
        return
    with db.connect() as conn:
        conn.execute("INSERT INTO chain_ops (kind, goal_id, user_id, contribution_id, amount_cents, memo, created_at, updated_at) "
                     "VALUES ('deposit', ?, ?, ?, ?, ?, ?, ?)", (goal_id, user_id, contribution_id, cents, memo, _now(), _now()))
    _wake.set()


def enqueue_refund(contribution_id: int, memo: str):
    """Take a contribution's GSD back out of the vault. If it never made it on-chain, just cancel it."""
    if not ENABLED:
        return
    with db.connect() as conn:
        dep = conn.execute("SELECT * FROM chain_ops WHERE kind = 'deposit' AND contribution_id = ? ORDER BY id DESC LIMIT 1",
                           (contribution_id,)).fetchone()
        if dep is None or dep["status"] in ("cancelled", "failed"):
            return
        if dep["status"] == "pending":
            conn.execute("UPDATE chain_ops SET status = 'cancelled', updated_at = ? WHERE id = ?", (_now(), dep["id"]))
            return
        conn.execute("INSERT INTO chain_ops (kind, goal_id, user_id, contribution_id, amount_cents, memo, created_at, updated_at) "
                     "VALUES ('refund', ?, ?, ?, ?, ?, ?, ?)",
                     (dep["goal_id"], dep["user_id"], contribution_id, dep["amount_cents"], memo, _now(), _now()))
    _wake.set()


def enqueue_goal_refunds(goal_id: int, title: str):
    """Goal deleted: give every on-chain deposit back."""
    with db.connect() as conn:
        ids = [r["contribution_id"] for r in conn.execute(
            "SELECT DISTINCT contribution_id FROM chain_ops WHERE goal_id = ? AND kind = 'deposit' AND contribution_id IS NOT NULL",
            (goal_id,))]
    for cid in ids:
        enqueue_refund(cid, f"Gatorstar | goal {goal_id} “{title[:40]}” deleted | refund of contribution {cid}")


def backfill():
    """Put contributions that have no on-chain record yet (demo data, older entries) in the queue."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT c.id, c.goal_id, c.user_id, c.amount_cents, c.nessie_id, g.title FROM contributions c "
            "JOIN goals g ON g.id = c.goal_id WHERE NOT EXISTS "
            "(SELECT 1 FROM chain_ops o WHERE o.contribution_id = c.id AND o.kind = 'deposit')").fetchall()
    for r in rows:
        enqueue_deposit(r["id"], r["goal_id"], r["user_id"], r["amount_cents"], deposit_memo(r["goal_id"], r["title"], r["id"], r["amount_cents"], r["nessie_id"]))
    return len(rows)


def deposit_memo(goal_id: int, title: str, contribution_id: int, cents: int, nessie_id: str | None) -> str:
    return (f"Gatorstar | goal {goal_id} “{title[:40]}” | contribution {contribution_id} | "
            f"${cents / 100:,.2f} | nessie {nessie_id or 'n/a'}")


def _process_one(auth: Keypair, mint: Pubkey) -> bool:
    """Advance the oldest unfinished step. Returns True if there may be more to do."""
    with db.connect() as conn:
        op = conn.execute("SELECT * FROM chain_ops WHERE status IN ('pending', 'sent') ORDER BY id LIMIT 1").fetchone()
    if op is None:
        return False

    if op["status"] == "sent":
        s = _statuses([op["signature"]])[0]
        if s and s.get("err"):
            _update(op["id"], status="pending", error=f"Transaction failed: {s['err']}")
        elif s and s.get("confirmationStatus") in ("confirmed", "finalized"):
            _update(op["id"], status="confirmed", error=None)
        elif time.time() - (op["sent_at"] or 0) > CONFIRM_TIMEOUT:
            _update(op["id"], status="pending", error="Didn't confirm in time; sending again")
        else:
            return False  # still in flight: check again next round
        return True

    if op["attempts"] >= 8:
        _update(op["id"], status="failed")
        return True
    member = wallet("user", op["user_id"])
    vault = wallet("goal", op["goal_id"])
    make = deposit_tx if op["kind"] == "deposit" else refund_tx
    tx = make(auth, member, vault, mint, op["amount_cents"], op["memo"], _blockhash())
    try:
        sig = send(tx)
    except ChainError as e:
        _update(op["id"], attempts=op["attempts"] + 1, error=str(e))
        raise
    _update(op["id"], status="sent", signature=sig, sent_at=time.time(), attempts=op["attempts"] + 1, error=None)
    return True


def _update(op_id: int, **fields):
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with db.connect() as conn:
        conn.execute(f"UPDATE chain_ops SET {cols} WHERE id = ?", (*fields.values(), op_id))


def step() -> None:
    """One round of the worker: make sure we're set up, then work through the queue."""
    with _lock:
        auth = authority()
        if not _ensure_funded(auth):
            return
        mint = ensure_mint(auth)
        _state.update(state="ready", error=None)
        for _ in range(20):
            if not _process_one(auth, mint):
                break


_wake = threading.Event()
_started = False


def start_worker():
    """Called at server start. Runs forever in the background."""
    global _started
    if not ENABLED or _started:
        if not ENABLED:
            _state["state"] = "off"
        return
    _started = True
    init_tables()

    def loop():
        n = backfill()
        if n:
            print(f"Queued {n} existing contributions to record on Solana {CLUSTER}.")
        while True:
            try:
                step()
            except ChainError as e:
                _state.update(state="offline", error=str(e))
            except Exception as e:  # never let the worker die
                _state.update(state="offline", error=f"{e.__class__.__name__}: {e}"[:200])
                print(f"Solana worker error: {e}")
            _wake.wait(WORKER_INTERVAL)
            _wake.clear()

    threading.Thread(target=loop, daemon=True, name="solana-worker").start()


# ---------- What the app shows ----------

def explorer_tx(sig: str) -> str:
    return f"{EXPLORER}/tx/{sig}?cluster={CLUSTER}"


def explorer_address(addr: str) -> str:
    return f"{EXPLORER}/address/{addr}?cluster={CLUSTER}"


def status() -> dict:
    if not ENABLED:
        return {"enabled": False, "state": "off", "error": MISSING_LIBRARY or "Turned off (SOLANA_ENABLED=0)", "network": CLUSTER}
    auth = authority()
    with db.connect() as conn:
        waiting = conn.execute("SELECT COUNT(*) AS n FROM chain_ops WHERE status IN ('pending', 'sent')").fetchone()["n"] if ENABLED else 0
    mint = _config("mint") if ENABLED else None
    return {
        "enabled": ENABLED, "state": _state["state"], "error": _state["error"], "network": CLUSTER,
        "app_wallet": str(auth.pubkey()) if auth else None,
        "app_wallet_url": explorer_address(str(auth.pubkey())) if auth else None,
        "fee_balance_sol": _state["sol_balance"],
        "token": {"symbol": "GSD", "name": "Gatorstar Savings Dollar", "mint": mint,
                  "url": explorer_address(mint) if mint else None},
        "waiting": waiting,
        "secret_is_from_env": bool(os.getenv("SOLANA_AUTHORITY_SECRET")),
    }


_balance_cache: dict = {}


def vault_info(goal_id: int, names: dict[int, str]) -> dict:
    """Everything the goal's vault panel shows. `names` maps user_id -> display name."""
    if not ENABLED:
        return {"enabled": False}
    vault_addr = str(wallet("goal", goal_id).pubkey())
    mint = _config("mint")
    with db.connect() as conn:
        ops = [dict(r) for r in conn.execute("SELECT * FROM chain_ops WHERE goal_id = ? ORDER BY id DESC", (goal_id,))]
        app_total = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM contributions WHERE goal_id = ?",
                                 (goal_id,)).fetchone()["c"]
    confirmed = sum(o["amount_cents"] * (1 if o["kind"] == "deposit" else -1) for o in ops if o["status"] == "confirmed")
    waiting = [o for o in ops if o["status"] in ("pending", "sent")]

    onchain, onchain_error = None, None
    if mint:
        # Reuse a balance read from the last few seconds, but only if no vault activity happened since.
        fingerprint = (len(ops), confirmed)
        hit = _balance_cache.get(goal_id)
        if hit and time.time() - hit[0] < 8 and hit[2] == fingerprint and not waiting:
            onchain = hit[1]
        else:
            try:
                onchain = token_balance(vault_addr, mint)
                _balance_cache[goal_id] = (time.time(), onchain, fingerprint)
            except ChainError as e:
                onchain_error = str(e)

    members: dict[int, dict] = {}
    for o in ops:
        m = members.setdefault(o["user_id"], {"user_id": o["user_id"], "name": names.get(o["user_id"], "Former member"),
                                              "wallet": wallet_address("user", o["user_id"]), "confirmed": 0, "waiting": 0})
        sign = 1 if o["kind"] == "deposit" else -1
        if o["status"] == "confirmed":
            m["confirmed"] += sign * o["amount_cents"]
        elif o["status"] in ("pending", "sent"):
            m["waiting"] += 1
    for m in members.values():
        m["confirmed"] = m["confirmed"] / 100
        m["wallet_url"] = explorer_address(m["wallet"]) if m["wallet"] else None

    by_contribution = {}
    for o in reversed(ops):   # oldest first, so the latest op for a contribution wins
        if o["contribution_id"] is not None:
            by_contribution[o["contribution_id"]] = {
                "kind": o["kind"], "status": o["status"],
                "url": explorer_tx(o["signature"]) if o["signature"] and o["status"] in ("sent", "confirmed") else None}

    return {
        "enabled": True, "network": CLUSTER, "state": _state["state"], "error": _state["error"],
        "vault_address": vault_addr, "vault_url": explorer_address(vault_addr),
        "token": {"symbol": "GSD", "mint": mint, "url": explorer_address(mint) if mint else None},
        "onchain_balance": onchain / 100 if onchain is not None else None,
        "onchain_error": onchain_error,
        "confirmed_total": confirmed / 100,
        "app_ledger_total": app_total / 100,
        "waiting": len(waiting),
        # Verified = the public chain holds exactly what the app's records say is in the pot.
        "verified": onchain is not None and not waiting and onchain == confirmed == app_total,
        "members": sorted(members.values(), key=lambda m: -m["confirmed"]),
        "transactions": [{
            "kind": o["kind"], "user": names.get(o["user_id"], "Former member"), "amount": o["amount_cents"] / 100,
            "status": o["status"], "created_at": o["created_at"], "error": o["error"] if o["status"] != "confirmed" else None,
            "url": explorer_tx(o["signature"]) if o["signature"] else None,
        } for o in ops if o["status"] != "cancelled"][:12],
        "by_contribution": by_contribution,
    }
