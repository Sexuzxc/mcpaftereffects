"""python -m ae_mcp            -> stdio MCP server
   python -m ae_mcp --http    -> streamable HTTP on :8678
   python -m ae_mcp --status  -> diagnostics"""

from .server import main

if __name__ == "__main__":
    main()
