const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { VSBrowser, ActivityBar, By, Workbench, Key } = require('vscode-extension-tester');

describe('Packaged VSIX', function () {
    let browser;
    async function row(label) {
        return browser.driver.wait(async () => {
            const rows = await browser.driver.findElements(By.css('.customview-tree .monaco-list-row'));
            for (const row of rows) {
                const labels = await row.findElements(By.css('.label-name'));
                for (const item of labels) if (await item.getText() === label && await row.isDisplayed()) return row;
            }
            return false;
        }, 15000, `Tree row ${label} must be visible`);
    }

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

    it('dims generated files, preserves manual expansion and offers the local folder action', async () => {
        const generated = await row('generated');
        assert.equal(await generated.getAttribute('aria-expanded'), 'false');
        assert.equal(await (await row('mixed')).getAttribute('aria-expanded'), 'true');
        await (await generated.findElement(By.css('.monaco-tl-twistie'))).click();
        const output = await row('output.ts');
        const manual = await row('manual.ts');
        const labelColor = async row => (await row.findElement(By.css('.label-name'))).getCssValue('color');
        assert.notEqual(await labelColor(output), await labelColor(manual), 'Generated output should have the muted theme color');
        await new Workbench().executeCommand('Git Tree Compare: Refresh');
        assert.equal(await (await row('generated')).getAttribute('aria-expanded'), 'true', 'Refresh must preserve manual expansion');
        await browser.driver.actions().contextClick(await row('manual.ts')).perform();
        await browser.driver.wait(async () => {
            const items = await browser.driver.findElements(By.css('.context-view .action-label'));
            for (const item of items) if ((await item.getText()).includes('Open Containing Folder')) return true;
            return false;
        }, 5000, 'Existing local files must offer Open Containing Folder');
        await browser.driver.actions().clear();
        await browser.driver.actions().sendKeys(Key.ESCAPE).perform();
        await browser.driver.wait(async () => {
            const blockers = await browser.driver.findElements(By.css('.context-view-block'));
            for (const blocker of blockers) if (await blocker.isDisplayed()) return false;
            return true;
        }, 5000, 'Context menu must close before continuing');
    });
    it('restores review progress after a full restart and retains the approved hash after edits', async () => {
        const checkbox = async () => (await row('example.txt')).findElement(By.css('[role="checkbox"]'));
        await (await checkbox()).click();
        await new Workbench().executeCommand('Git Tree Compare: Refresh');
        await browser.driver.wait(async () => (await (await checkbox()).getAttribute('aria-checked')) === 'true', 15000,
            'The review must validate before restarting');
        await browser.quit();
        // ExTester wipes settings before each start. The launcher restores this
        // disposable profile, including the real VS Code storage database.
        await fs.cp(path.join(process.env.TEST_RESOURCES, 'settings'), path.join(process.env.TEST_RESOURCES, 'restart-profile'), {
            recursive: true,
            filter: async source => {
                if (path.basename(source) === 'DevToolsActivePort') return false;
                const stat = await fs.lstat(source);
                return stat.isFile() || stat.isDirectory();
            },
        });
        await browser.start(process.env.GTC_UI_LAUNCHER, [process.env.GTC_TEST_REPOSITORY]);
        await browser.waitForWorkbench();
        await (await new ActivityBar().getViewControl('Git Tree Compare')).openView();
        await browser.driver.wait(async () => (await (await checkbox()).getAttribute('aria-checked')) === 'true', 15000,
            'The review must survive quitting and restarting VS Code');
        // Record even transient unchecked renders while switching views.
        await browser.driver.executeScript(() => {
            window.reviewFlicker = [];
            window.reviewObserver = new MutationObserver(() => {
                const rows = document.querySelectorAll('.customview-tree .monaco-list-row');
                for (const row of rows) {
                    if (row.querySelector('.label-name')?.textContent === 'example.txt' &&
                        row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked') === 'false') {
                        window.reviewFlicker.push('unchecked');
                    }
                }
            });
            window.reviewObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked'] });
        });
        await (await new ActivityBar().getViewControl('Explorer')).openView();
        await (await new ActivityBar().getViewControl('Git Tree Compare')).openView();
        await new Workbench().executeCommand('Git Tree Compare: Refresh');
        await browser.driver.wait(async () => (await (await checkbox()).getAttribute('aria-checked')) === 'true', 15000);
        const flicker = await browser.driver.executeScript(() => {
            window.reviewObserver.disconnect();
            return window.reviewFlicker;
        });
        assert.deepEqual(flicker, [], 'Switching views must not briefly render reviewed files unchecked');
        const file = path.join(process.env.GTC_TEST_REPOSITORY, 'example.txt');
        await fs.writeFile(file, 'changed by an agent after review\n');
        await browser.driver.wait(async () => (await (await checkbox()).getAttribute('aria-checked')) === 'false', 15000,
            'An external edit must invalidate the review');
        await fs.writeFile(file, 'working changes\n');
        await browser.driver.wait(async () => (await (await checkbox()).getAttribute('aria-checked')) === 'true', 15000,
            'Restoring the approved version must restore its check');
    });

});
