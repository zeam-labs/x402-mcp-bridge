# zeam-prism

A web3.py provider that pays [ZEAM Prism](https://mcp.zeamprism.com/llms.txt) from a wallet.

```
pip install 'git+https://github.com/zeam-labs/x402-mcp-bridge@<commit>#subdirectory=python'
```

Not on PyPI, on purpose: this code holds your key, so it installs from a commit
you can read and that cannot be changed under you.

```python
from web3 import Web3
from zeam_prism import PrismProvider

w3 = Web3(PrismProvider(key=os.environ["X402_PRIVATE_KEY"]))
w3.eth.block_number      # paid from the wallet, served by an archive node
```

Nothing else changes. The provider speaks JSON-RPC to Prism's `/rpc/base` (or
`/rpc/eth` with `chain="eth"`) and x402 back. The first request funds a channel
and buys one block; after that it holds a line, keeps the meter on while calls
flow, switches it off a second after they stop, and lets the line go after ten
idle seconds. `state()`, `close()` and `refund()` are on the provider. Call
`close()` or `refund()` before exit.

Options: `url`, `chain`, `network`, `state_dir`, `deposit_multiplier`, `rpc_url`
(a node for the payment client's own chain reads), `ahead_ms`, `idle_ms`,
`drop_after_ms`, `log`. `X402_PRIVATE_KEY`, `X402_MCP_URL`, `X402_STATE_DIR`,
`X402_RPC_URL` are read from the environment when not given.
