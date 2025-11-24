
//   // Dynamically import ESM-only SDK
// const MCPServer = require('@modelcontextprotocol/sdk/server');
// const vscode = require('vscode');

//   // Create your MCP server
//   const server = new MCPServer.Server({
//     name: 'my-embedded-server',
//     version: '1.0.0',
//   });


//   server.registerCapabilitiesresourceTypes.register('works

//   // Example: register a resource
//   server.registerCapabilitiesresources.register('workspace-files', async () => {
//     const files = await vscode.workspace.findFiles('**/*');
//     return files.map(uri => ({ uri: uri.toString() }));
//   });

//   // Example: register a tool
//   server.tools.register('showMessage', async (args) => {
//     const msg = args?.message || 'Hello from my embedded MCP server!';
//     vscode.window.showInformationMessage(msg);
//     return { ok: true };
//   });

//   // Start the MCP server (for Roo Code to connect)
//   server.listenStdio();

//   console.log('✅ Embedded MCP server started inside VS Code');



