/**
 * Legacy lane: the deprecated-but-supported `McpAgent` (Durable Object + SDK v1 server) kept
 * only for clients that still speak the HTTP+SSE transport (`GET /sse`, `POST /sse/message`).
 * New clients should use the stateless `/mcp` route. Remove this file, the `MCP_OBJECT`
 * binding and the DO migration once no SSE clients remain.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { SERVER_NAME, SERVER_VERSION, type LedgerEnv } from "../env";
import { SERVER_INSTRUCTIONS, createDeps, registerLedgerCapabilities, type Registrar } from "./definitions";

export class LedgerMcp extends McpAgent<LedgerEnv> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  async init(): Promise<void> {
    registerLedgerCapabilities(v1Registrar(this.server), createDeps(this.env));
  }
}

/** SDK v1 takes raw zod shapes for tools and prompts. */
function v1Registrar(server: McpServer): Registrar {
  return {
    tool(def) {
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.input,
          annotations: { readOnlyHint: def.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: def.openWorld },
        },
        (args) => def.run(args),
      );
    },
    resource(def) {
      server.registerResource(def.name, def.uri, { title: def.title, description: def.description, mimeType: def.mimeType }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: def.mimeType, text: await def.read(uri) }],
      }));
    },
    resourceTemplate(def) {
      const list = def.list;
      const template = new ResourceTemplate(def.uriTemplate, { list: list ? async () => ({ resources: list() }) : undefined });
      server.registerResource(def.name, template, { title: def.title, description: def.description, mimeType: def.mimeType }, async (uri, variables) => ({
        contents: [{ uri: uri.href, mimeType: def.mimeType, text: await def.read(uri, variables) }],
      }));
    },
    prompt(def) {
      server.registerPrompt(def.name, { title: def.title, description: def.description, argsSchema: def.args }, (args) => def.get(args));
    },
  };
}
