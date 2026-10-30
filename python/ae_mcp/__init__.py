"""after-effects-mcp - Python MCP server for Adobe After Effects.

A thin transport layer in front of the resident ExtendScript bridge
(bridge/ae_bridge.jsx): the server exposes ~95 tools from registry/tools.json
and forwards every call through the file-based mailbox to After Effects.
"""

__version__ = "1.0.0"
