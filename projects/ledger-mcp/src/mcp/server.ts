/** SDK v2 server factory for the stateless `/mcp` route (`createMcpHandler`). */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION, type LedgerEnv } from "../env";
import { SERVER_INSTRUCTIONS, createDeps, registerLedgerCapabilities, type Registrar } from "./definitions";

export function createLedgerServer(env: LedgerEnv): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerLedgerCapabilities(v2Registrar(server), createDeps(env));
  return server;
}

function v2Registrar(server: McpServer): Registrar {
  return {
    tool(def) {
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: z.object(def.input),
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
      server.registerPrompt(def.name, { title: def.title, description: def.description, argsSchema: z.object(def.args) }, (args) => def.get(args));
    },
  };
}
