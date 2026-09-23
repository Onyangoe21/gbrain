import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { SkillResources } from './skill-resources.ts';

export const CAPABILITIES_URI = 'gbrain://capabilities';

/** Resources keep orientation available even on the exact seven-tool surface. */
export function installCapabilitiesResource(server: Server, describe: () => unknown | Promise<unknown>, skills?: SkillResources) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [
    { uri: CAPABILITIES_URI, name: 'GBrain capabilities', description: 'Effective permissions and setup readiness for this connection.', mimeType: 'application/json' },
    ...(await skills?.list() ?? []),
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== CAPABILITIES_URI) {
      if (skills) return skills.read(request.params.uri);
      throw new McpError(ErrorCode.InvalidParams, 'Unknown resource');
    }
    return { contents: [{ uri: CAPABILITIES_URI, mimeType: 'application/json', text: JSON.stringify(await describe()) }] };
  });
}
