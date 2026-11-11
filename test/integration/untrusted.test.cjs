const assert = require('node:assert/strict');
const vscode = require('vscode');
describe('Workspace Trust', () => {
    it('keeps the extension inactive in an untrusted workspace', async () => {
        assert.equal(vscode.workspace.isTrusted, false);
        const extension = vscode.extensions.getExtension('bentefay.git-tree-compare');
        assert.ok(extension);
        assert.equal(extension.packageJSON.capabilities.untrustedWorkspaces.supported, false);
        assert.equal(extension.isActive, false);
    });
});
