import json
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from eth_account import Account
from eth_account.messages import encode_defunct
from web3.providers.base import JSONBaseProvider
from websockets.sync.client import connect as ws_connect
from x402 import x402ClientSync
from x402.http import x402HTTPClientSync
from x402.http.utils import encode_payment_signature_header
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementDepositPolicy,
    BatchSettlementEvmScheme,
    BatchSettlementEvmSchemeOptions,
    FileChannelStorageOptions,
    FileClientChannelStorage,
)
from x402.mechanisms.evm.signers import EthAccountSignerWithRPC
from x402.schemas import PaymentRequired

LINE_HEADER = "x-line"
LINE_GONE = {"unknown_line", "line_closed"}
PUBLIC_RPC = {"eip155:8453": "https://mainnet.base.org", "eip155:1": "https://eth.llamarpc.com"}


def _ws_url(url: str) -> str:
    u = urlsplit(url)
    return urlunsplit(("wss" if u.scheme == "https" else "ws", u.netloc, "/pay", "", ""))


class _Wallet:
    def __init__(self, key, url, network, state_dir, deposit_multiplier, salt, rpc_url, log):
        if not key or not (key.startswith("0x") and len(key) == 66):
            raise ValueError("PrismProvider: key must be a 0x-prefixed 32-byte private key. It signs vouchers locally and is never sent anywhere.")
        self.account = Account.from_key(key)
        host = urlsplit(url).netloc
        self.dir = Path(state_dir or Path.home() / ".x402-mcp-bridge" / host / self.account.address.lower())
        self.dir.mkdir(parents=True, exist_ok=True)
        self.channel_id = None
        client_dir = self.dir / "client"
        if client_dir.is_dir():
            for f in client_dir.iterdir():
                if f.suffix == ".json":
                    self.channel_id = f.stem
                    break
        inner = FileClientChannelStorage(FileChannelStorageOptions(directory=str(self.dir)))
        wallet = self

        class _Watched:
            def get(self, k): return inner.get(k)
            def delete(self, k):
                if wallet.channel_id == k: wallet.channel_id = None
                return inner.delete(k)
            def set(self, k, ctx):
                wallet.channel_id = k
                return inner.set(k, ctx)

        signer = EthAccountSignerWithRPC(self.account, rpc_url or PUBLIC_RPC.get(network, PUBLIC_RPC["eip155:8453"]))
        options = BatchSettlementEvmSchemeOptions(
            storage=_Watched(),
            deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=float(deposit_multiplier)) if deposit_multiplier else None,
            salt=salt,
        )
        self.payments = x402ClientSync().register(network, BatchSettlementEvmScheme(signer, options))
        self.http = x402HTTPClientSync(self.payments)
        self.lock = threading.Lock()
        log(f"prism: paying as {self.account.address}, state in {self.dir}")

    def sign(self, message: str) -> str:
        return "0x" + self.account.sign_message(encode_defunct(text=message)).signature.hex().removeprefix("0x")

    def paid(self, session: httpx.Client, url: str, body: bytes, headers: dict) -> httpx.Response:
        with self.lock:
            r = session.post(url, content=body, headers=headers)
            if r.status_code != 402:
                return r
            try:
                pay_headers, payload = self.http.handle_402_response(dict(r.headers), r.content, url)
            except Exception as e:
                raise RuntimeError(f"prism: could not read the payment requirements: {e}") from e
            r2 = session.post(url, content=body, headers={**headers, **pay_headers})
            if payload is not None:
                try: self.http.process_payment_result(payload, lambda n: r2.headers.get(n), r2.status_code)
                except Exception: pass
            return r2


class _Line:
    def __init__(self, url, wallet, ahead_ms, idle_ms, drop_after_ms, log):
        self.url, self.w, self.log = url, wallet, log
        self.ahead_ms, self.idle_ms, self.drop_after_ms = ahead_ms, idle_ms, drop_after_ms
        self.socket = None; self.credential = None; self.metering = False
        self.remaining_ms = 0; self.read_at = 0.0
        self.waiting: dict[str, tuple[threading.Event, list]] = {}
        self.off_timer = None; self.drop_timer = None
        self.tick_terms = None; self.tick_lock = threading.Lock(); self.lock = threading.RLock()
        self.session = httpx.Client(timeout=120)

    def remaining(self) -> float:
        burned = (time.time() - self.read_at) * 1000 if self.metering else 0
        return max(0.0, self.remaining_ms - burned)

    def _read(self, ms, metering=None):
        self.remaining_ms = float(ms or 0); self.read_at = time.time()
        if metering is not None: self.metering = bool(metering)

    def _send(self, frame):
        try:
            if self.socket: self.socket.send(json.dumps(frame))
        except Exception: pass

    def _ask(self, op, frame, timeout=10.0):
        if not self.socket: return None
        ev, box = threading.Event(), []
        self.waiting[op] = (ev, box)
        self._send(frame)
        ev.wait(timeout)
        self.waiting.pop(op, None)
        return box[0] if box else None

    def _settle(self, op, frame):
        w = self.waiting.get(op)
        if w: w[1].append(frame); w[0].set()

    def _reader(self, socket):
        try:
            for raw in socket:
                try: m = json.loads(raw)
                except Exception: continue
                op = m.get("op")
                if op == "meter": self._read(m.get("msRemaining"), m.get("metering"))
                elif op in ("on", "off"): self._read(m.get("msRemaining"), op == "on"); self._settle(op, m)
                elif op in ("refunded", "refund_failed"): self._settle("refund", m)
                elif op == "closing": self.log(f"prism: line closing: {m.get('why')}"); self.drop(m.get("why"))
                elif op == "error": self.log(f"prism: /pay: {m.get('error')}")
        except Exception:
            pass
        if self.socket is socket: self.drop("socket closed")

    def open(self):
        with self.lock:
            if self.credential: return self.credential
            if not self.w.channel_id: return None
            try:
                socket = ws_connect(_ws_url(self.url), open_timeout=10)
            except Exception as e:
                self.log(f"prism: line: {e}"); return None
            socket.send(json.dumps({"op": "open", "channelId": self.w.channel_id}))
            deadline = time.time() + 10
            while time.time() < deadline:
                try: m = json.loads(socket.recv(timeout=deadline - time.time()))
                except Exception: break
                op = m.get("op")
                if op == "challenge":
                    socket.send(json.dumps({"op": "prove", "signature": self.w.sign(m["message"])}))
                elif op == "open_failed":
                    self.log(f"prism: line refused: {m.get('error') or m.get('why')}"); break
                elif op == "opened":
                    self.socket, self.credential = socket, m["credential"]
                    self._read(m.get("msRemaining"), m.get("metering"))
                    self.log(f"prism: line open, {m.get('msRemaining')}ms on the meter, collateral buys {m.get('buysMs', '?')}ms")
                    threading.Thread(target=self._reader, args=(socket,), daemon=True).start()
                    return self.credential
            try: socket.close()
            except Exception: pass
            return None

    def on(self):
        if self.metering or not self.credential: return
        if self._ask("on", {"op": "on"}) is None: self.metering = False

    def off(self):
        if not self.metering or not self.credential: return
        self._ask("off", {"op": "off"})

    def touch(self):
        for t in (self.off_timer, self.drop_timer):
            if t: t.cancel()
        self.off_timer = threading.Timer(self.idle_ms / 1000, self.off); self.off_timer.daemon = True; self.off_timer.start()
        self.drop_timer = threading.Timer(self.drop_after_ms / 1000, self.drop, args=("idle",)); self.drop_timer.daemon = True; self.drop_timer.start()

    def drop(self, why):
        with self.lock:
            for t in (self.off_timer, self.drop_timer):
                if t: t.cancel()
            self.off_timer = self.drop_timer = None
            for ev, _ in list(self.waiting.values()): ev.set()
            self.waiting.clear()
            sock, self.socket = self.socket, None
            if self.credential: self.log(f"prism: line closed ({why})")
            self.credential = None; self.metering = False
            if sock:
                try: sock.close()
                except Exception: pass

    def _terms(self):
        if self.tick_terms: return self.tick_terms
        try:
            j = self.session.get(self.url + "/.well-known/x402").json()
            accepts = j.get("tickAccepts") or j.get("accepts")
            if accepts: self.tick_terms = PaymentRequired.model_validate({"x402Version": j.get("x402Version", 2), "accepts": accepts})
        except Exception: pass
        return self.tick_terms

    def tick_once(self) -> bool:
        with self.w.lock:
            if not self.credential: return False
            url = self.url + "/v1/tick"
            base = {LINE_HEADER: self.credential, "content-type": "application/json"}
            r = None
            terms = self._terms()
            if terms is not None:
                try:
                    payload = self.w.payments.create_payment_payload(terms)
                    r = self.session.post(url, content=b"{}", headers={**base, "PAYMENT-SIGNATURE": encode_payment_signature_header(payload)})
                    try: self.w.http.process_payment_result(payload, lambda n: r.headers.get(n), r.status_code)
                    except Exception: pass
                    if r.status_code == 402: self.tick_terms = None; r = None
                except Exception as e:
                    self.log(f"prism: pay-first tick failed ({e}); asking the door"); r = None
            if r is None:
                r = self.session.post(url, content=b"{}", headers=base)
                if r.status_code == 402:
                    pay_headers, payload = self.w.http.handle_402_response(dict(r.headers), r.content, url)
                    r = self.session.post(url, content=b"{}", headers={**base, **pay_headers})
                    if payload is not None:
                        try: self.w.http.process_payment_result(payload, lambda n: r.headers.get(n), r.status_code)
                        except Exception: pass
            try: j = r.json()
            except Exception: j = None
            if r.status_code != 200 or (j or {}).get("paid") is False:
                self.drop(f"tick refused: {(j or {}).get('error') or (j or {}).get('why') or r.status_code}"); return False
            self._read(j.get("msRemaining"), self.metering)
            return True

    def ensure(self, min_ms) -> bool:
        while self.credential and self.remaining() < min_ms:
            if not self.tick_once(): return False
        return bool(self.credential)

    def top_up(self):
        if not self.tick_lock.acquire(blocking=False): return
        def run():
            try:
                while self.credential and self.remaining() < self.ahead_ms:
                    if not self.tick_once(): break
            finally: self.tick_lock.release()
        threading.Thread(target=run, daemon=True).start()

    def refund(self) -> dict:
        channel_id = self.w.channel_id
        if not channel_id: return {"op": "refund_failed", "why": "no channel"}
        issued = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
        signature = self.w.sign(f"ZEAM Prism refund\nchannel: {channel_id.lower()}\nissued: {issued}")
        try:
            with ws_connect(_ws_url(self.url), open_timeout=10) as socket:
                socket.send(json.dumps({"op": "refund", "channelId": channel_id, "issued": issued, "signature": signature}))
                deadline = time.time() + 90
                while time.time() < deadline:
                    m = json.loads(socket.recv(timeout=deadline - time.time()))
                    if m.get("op") in ("refunded", "refund_failed") or m.get("error"): return m
        except Exception as e:
            return {"op": "refund_failed", "why": str(e)}
        return {"op": "refund_failed", "why": "timeout"}


class PrismProvider(JSONBaseProvider):
    def __init__(self, key=None, url=None, chain="base", network=None, state_dir=None, deposit_multiplier=None,
                 salt=None, rpc_url=None, ahead_ms=2000, idle_ms=1000, drop_after_ms=10000, block_ms=250, log=None):
        super().__init__()
        key = key or os.environ.get("X402_PRIVATE_KEY")
        url = (url or os.environ.get("X402_MCP_URL") or "https://mcp.zeamprism.com").rstrip("/")
        if url.endswith("/mcp"): url = url[:-4]
        network = network or os.environ.get("X402_NETWORK", "eip155:8453")
        self.log = log or (lambda *a: print(*a, file=__import__("sys").stderr))
        self.w = _Wallet(key, url, network, state_dir or os.environ.get("X402_STATE_DIR"), deposit_multiplier or os.environ.get("X402_DEPOSIT_MULTIPLIER"),
                         salt or os.environ.get("X402_SALT"), rpc_url or os.environ.get("X402_RPC_URL"), self.log)
        self.l = _Line(url, self.w, ahead_ms, idle_ms, drop_after_ms, self.log)
        self.block_ms = block_ms
        self.door = f"{url}/rpc/{chain}"

    def _code(self, r: httpx.Response):
        try: j = r.json()
        except Exception: return None
        first = j[0] if isinstance(j, list) and j else j
        d = (first or {}).get("error", {}).get("data") or first or {}
        return d.get("code") or d.get("error")

    def _fetch(self, body: bytes) -> httpx.Response:
        headers = {"content-type": "application/json"}
        for _ in range(3):
            if not self.l.credential and self.w.channel_id: self.l.open()
            if self.l.credential:
                self.l.on()
                if not self.l.ensure(self.block_ms + 50): continue
                self.l.top_up()
                r = self.l.session.post(self.door, content=body, headers={**headers, LINE_HEADER: self.l.credential})
                self.l.touch()
                if r.status_code != 402: return r
                code = self._code(r)
                if code == "line_unpaid": self.l.metering = False; self.l.remaining_ms = 0; continue
                if code in LINE_GONE: self.l.drop(code); continue
                return r
            r = self.w.paid(self.l.session, self.door, body, headers)
            if r.status_code != 402: return r
            if self._code(r) == "line_required" and self.w.channel_id: self.l.open(); continue
            return r
        raise RuntimeError("prism: could not hold a line after three attempts")

    def make_request(self, method, params):
        r = self._fetch(self.encode_rpc_request(method, params))
        if r.status_code >= 400 and r.status_code != 402:
            raise RuntimeError(f"prism: HTTP {r.status_code}: {r.text[:200]}")
        return self.decode_rpc_response(r.content)

    def is_connected(self, show_traceback=False) -> bool:
        try: return self.l.session.get(self.door).status_code == 200
        except Exception: return False

    def state(self) -> dict:
        return {"address": self.w.account.address, "channelId": self.w.channel_id, "line": bool(self.l.credential),
                "metering": self.l.metering, "msRemaining": int(self.l.remaining())}

    def close(self):
        try: self.l.off()
        except Exception: pass
        self.l.drop("closed")

    def refund(self) -> dict:
        self.l.drop("refunding")
        with self.w.lock: pass
        r = {}
        for _ in range(6):
            r = self.l.refund()
            if r.get("op") == "refunded" or "still open" not in str(r.get("why", "")): return r
            time.sleep(1)
        return r
