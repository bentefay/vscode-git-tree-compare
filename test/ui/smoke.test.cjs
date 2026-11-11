const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { VSBrowser, ActivityBar, By } = require('vscode-extension-tester');

describe('Packaged VSIX', function () {
    let browser;
    before(async function () {
        browser = new VSBrowser(process.env.GTC_VSCODE_VERSION, 'stable', {
            'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom',
            'telemetry.telemetryLevel': 'off', 'git.autofetch': false,
            'gitTreeCompare.showCommitsPanel': true,
            'chat.disableAIFeatures': true,
        });
        await browser.start(process.env.GTC_UI_LAUNCHER, [process.env.GTC_TEST_REPOSITORY]);
        await browser.waitForWorkbench();
        if (process.platform === 'linux') {
            assert.equal(process.env.WAYLAND_DISPLAY, undefined, 'Tests must not inherit the desktop compositor');
            assert.deepEqual(await browser.driver.executeScript('return [screen.width, screen.height]'), [1440, 1000],
                'The browser must be on the private Xvfb display');
        }
    });
    afterEach(async function () {
        if (!browser) return;
        await browser.takeScreenshot(this.currentTest.state === 'failed' ? 'failure' : 'tree');
        await fs.writeFile(path.join(process.env.GTC_TEST_RESULTS, 'workbench.html'), await browser.driver.getPageSource());
    });
    after(async () => {
        if (browser?.driver) {
            // Preserve evidence even when startup assertions fail in before().
            try { await browser.takeScreenshot('final'); }
            finally { await browser.quit(); }
        }
    });
    it('opens the comparison view and a real diff editor', async () => {
        const control = await new ActivityBar().getViewControl('Git Tree Compare');
        assert.ok(control, 'Packaged extension must contribute its activity bar view');
        await control.openView();
        const file = await browser.driver.wait(async () => {
            const matches = await browser.driver.findElements(By.css('[aria-label*="example.txt"]'));
            for (const element of matches) if (await element.isDisplayed()) return element;
            return false;
        }, 30000, 'Comparison tree must contain example.txt');
        await browser.driver.actions().doubleClick(file).perform();
        await browser.driver.wait(async () => (await browser.driver.findElements(By.css('.monaco-diff-editor'))).length > 0,
            15000, 'Diff editor must open');
        assert.ok((await browser.driver.findElements(By.css('.monaco-diff-editor'))).length);
    });
});
