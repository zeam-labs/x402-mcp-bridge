# Drive the provider against a live Prism. Spends real money from the key.
#
#   PRISM_TEST_URL=https://mcp.zeamprism.com X402_PRIVATE_KEY=0x... python test/live.py
import os, sys, time, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from web3 import Web3
from zeam_prism import PrismProvider

url = os.environ.get("PRISM_TEST_URL", "https://mcp.zeamprism.com")
key = os.environ["X402_PRIVATE_KEY"]
passed = failed = 0
def check(c, name, detail=""):
    global passed, failed
    passed += c; failed += (not c)
    print(f"  {'PASS' if c else 'FAIL'}  {name}{' — ' + detail if detail else ''}")
def timed(fn):
    t = time.time(); v = fn(); return v, int((time.time() - t) * 1000)

state_dir = os.environ.get("PRISM_STATE_DIR") or tempfile.mkdtemp(prefix="prism-py-")
p = PrismProvider(key=key, url=url, chain="base", state_dir=state_dir, log=lambda *a: print("   ", *a, file=sys.stderr))
w3 = Web3(p)

print("\nfirst call funds the channel and buys a block")
n1, t1 = timed(lambda: w3.eth.block_number)
check(isinstance(n1, int) and n1 > 0, "block_number answers through the door", f"{n1} in {t1}ms")
check(bool(p.state()["channelId"]), "a channel exists now", str(p.state()["channelId"])[:14])

print("\ncalls that keep coming ride a line")
times = [timed(lambda: w3.eth.chain_id)[1] for _ in range(10)]
st = p.state()
check(st["line"] and st["metering"], "a line is open and the meter is on", str(st))
check(all(t < 1500 for t in times[2:]), "ten calls answered", " ".join(map(str, times)) + " ms")

print("\nthe archive answers a real read")
head = w3.eth.block_number
usdc = Web3.to_checksum_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
logs, tl = timed(lambda: w3.eth.get_logs({"address": usdc, "fromBlock": head - 50, "toBlock": head,
    "topics": [Web3.keccak(text="Transfer(address,address,uint256)").hex()]}))
check(len(logs) > 0, "USDC transfers over 50 blocks", f"{len(logs)} logs in {tl}ms")
code, _ = timed(lambda: w3.eth.get_code(usdc))
check(len(code) > 0, "get_code on USDC", f"{len(code)} bytes")

print("\nthe meter goes off when calls stop, and on again when they resume")
time.sleep(1.8)
idle = p.state()
check(idle["line"] and not idle["metering"], "idle: line held, meter off", str(idle))
before = idle["msRemaining"]; time.sleep(1.0)
check(abs(p.state()["msRemaining"] - before) <= 5, "a second off burned nothing", f"{before} -> {p.state()['msRemaining']}")
n2 = w3.eth.block_number
check(n2 >= n1 and p.state()["metering"], "the next call switches the meter on and answers", str(n2))

print("\nrefund")
r = p.refund()
check(r.get("op") == "refunded", "the collateral and the unburned time come back",
      f"{r.get('microUSD')} micro-USD {str(r.get('transaction'))[:14]}" if r.get("op") == "refunded" else str(r.get("why") or r.get("error")))
print(f"\n  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
