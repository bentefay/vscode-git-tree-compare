const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { VSBrowser, ActivityBar, By, Workbench, Key, InputBox } = require('vscode-extension-tester');

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

    async function openFile(name) {
        const modifier = process.platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
        await browser.driver.actions().keyDown(modifier).sendKeys('p').keyUp(modifier).perform();
        const quickOpen = await InputBox.create();
        await quickOpen.setText(path.join(process.env.GTC_TEST_REPOSITORY, name));
        await quickOpen.confirm();
        await browser.driver.wait(async () => {
            const tabs = await browser.driver.findElements(By.css('.tab.active'));
            for (const tab of tabs) if ((await tab.getAttribute('aria-label') || '').includes(path.basename(name))) return true;
            return false;
        }, 10000, 'The unchanged file must be active');
    }

    async function clickCommentButton(label) {
        await browser.driver.wait(async () => {
            try {
                for (const item of await browser.driver.findElements(By.css('.review-widget .monaco-button'))) {
                    if (await item.isDisplayed() && (await item.getText()) === label &&
                        (await item.getAttribute('aria-disabled')) !== 'true') {
                        await item.click();
                        return true;
                    }
                }
            } catch (error) {
                if (error.name !== 'StaleElementReferenceError') throw error;
                // Comment action buttons are replaced when input enablement changes.
            }
            return false;
        }, 10000, `${label} must be an enabled native comment action`);
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
        await browser.driver.actions().clear();
        await browser.takeScreenshot((this.currentTest.state === 'failed' ? 'failure-' : 'tree-') + this.currentTest.title.replace(/[^a-z]+/gi, '-').slice(0, 65));
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
        for (const label of ['Compare From', 'PR Commits']) {
            const header = await browser.driver.wait(async () => {
                const matches = await browser.driver.findElements(By.css(`.pane-header[aria-label^="${label}"][aria-label$=" Section"]`));
                return matches[0] || false;
            }, 10000, `${label} must be contributed`);
            assert.equal(await header.getAttribute('aria-expanded'), 'false', `${label} must start collapsed`);
        }
        await browser.takeScreenshot('review-panes-collapsed');
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

    it('offers native Orca comments on unchanged lines and sends the typed feedback', async () => {
        await openFile('other.txt');
        await new Workbench().executeCommand('Git Tree Compare: Add Orca Comment');
        const input = await browser.driver.wait(async () => {
            const items = await browser.driver.findElements(By.css('.comment-form .monaco-editor'));
            for (const item of items) if (await item.isDisplayed()) return item;
            return false;
        }, 15000, 'The native comment editor must appear on an unchanged file');
        await browser.driver.actions().clear();
        await input.click();
        await browser.driver.actions().sendKeys('Please simplify this unchanged line.').perform();
        await browser.takeScreenshot('orca-comment-editor');
        await clickCommentButton('Send to Orca');
        const callsFile = path.join(process.env.GTC_TEST_RESULTS, 'orca-calls.jsonl');
        await browser.driver.wait(async () => {
            const calls = (await fs.readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
            return calls.some(args => args[1] === 'switch');
        }, 15000, 'The fake Orca CLI must accept the message and focus the target');
        const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
        const send = calls.find(args => args[1] === 'send');
        assert.equal(send[send.indexOf('--terminal') + 1], 'selected-agent');
        const prompt = send[send.indexOf('--text') + 1];
        assert.ok(prompt.includes('Please simplify this unchanged line.'));
        assert.ok(prompt.includes('other.txt'));
        await browser.takeScreenshot('orca-comment-sent');
        // Keep the original comparison view visible for the following review tests.
        await (await new ActivityBar().getViewControl('Git Tree Compare')).openView();
    });

    it('saves an editable Orca note before the editor restart', async () => {
        await openFile('committed.txt');
        await new Workbench().executeCommand('Git Tree Compare: Add Orca Comment');
        await browser.driver.actions().clear();
        const editor = await browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.comment-form .monaco-editor'))) {
                if (await item.isDisplayed()) return item;
            }
            return false;
        }, 10000);
        await editor.click();
        await browser.driver.actions().sendKeys('Saved review draft').perform();
        await clickCommentButton('Save Note');
        await browser.driver.wait(async () => (await browser.driver.getPageSource()).includes('Saved locally'), 10000);
        await (await new ActivityBar().getViewControl('Git Tree Compare')).openView();
    });

    it('dims generated files, preserves manual expansion and offers the local folder action', async () => {
        const generated = await row('generated');
        assert.equal(await generated.getAttribute('aria-expanded'), 'false');
        assert.equal(await (await row('mixed')).getAttribute('aria-expanded'), 'true');
        await (await generated.findElement(By.css('.monaco-tl-twistie'))).click();
        const output = await row('output.ts');
        const manual = await row('manual.ts');
        const labelColor = async row => (await row.findElement(By.css('.label-name'))).getCssValue('color');
        await browser.driver.wait(async () => (await labelColor(output)) !== (await labelColor(manual)), 10000,
            'Generated output should have the muted theme color once decorations arrive');
        await new Workbench().executeCommand('Git Tree Compare: Refresh');
        assert.equal(await (await row('generated')).getAttribute('aria-expanded'), 'true', 'Refresh must preserve manual expansion');
        for (const label of ['manual.ts', 'generated']) {
            await browser.driver.actions().contextClick(await row(label)).perform();
            await browser.driver.wait(async () => {
                const items = await browser.driver.findElements(By.css('.context-view .action-label'));
                for (const item of items) if ((await item.getText()).includes('Open Containing Folder')) return true;
                return false;
            }, 5000, 'Existing local files and folders must offer Open Containing Folder');
            if (label === 'generated') { await browser.takeScreenshot('folder-containing-menu'); }
            await browser.driver.actions().clear();
            await browser.driver.actions().sendKeys(Key.ESCAPE).perform();
            await browser.driver.wait(async () => {
                const blockers = await browser.driver.findElements(By.css('.context-view-block'));
                for (const blocker of blockers) if (await blocker.isDisplayed()) return false;
                return true;
            }, 5000, 'Context menu must close before continuing');
        }
    });
    it('reveals included editor and inactive-tab files and opens their comparison diffs', async () => {
        const title = 'Reveal in Git Tree Compare View';
        const diffTitle = 'Open Git Tree Compare Diff';
        const menuItems = async () => {
            const items = await browser.driver.findElements(By.css('.context-view .action-label'));
            // Recent VS Code editors host their context menu in a shadow root;
            // tab menus can still use the workbench's ordinary context view.
            for (const host of await browser.driver.findElements(By.css('.shadow-root-host'))) {
                const shadow = await host.getShadowRoot();
                items.push(...await shadow.findElements(By.css('.action-label')));
            }
            return items;
        };
        const menuItem = async (label = title) => {
            for (const item of await menuItems()) {
                if (await item.isDisplayed() && await item.getText() === label) return item;
            }
            return false;
        };
        const selectReveal = async (message, label = title) => {
            const item = await browser.driver.wait(() => menuItem(label), 10000, message);
            // Use a complete pointer gesture: a direct WebElement click can
            // leave VS Code's freshly opened menu focused without activating it.
            await browser.driver.actions().move({ origin: item }).click().perform();
            await browser.driver.wait(async () => {
                try { return !await menuItem(label); }
                catch (error) {
                    // The menu and its shadow root can disappear mid-query.
                    if (!['StaleElementReferenceError', 'DetachedShadowRootError', 'NoSuchShadowRootError'].includes(error.name)) { throw error; }
                    return false;
                }
            }, 10000, 'The action must close the context menu');
        };
        const tab = async name => browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.tab'))) {
                if ((await item.getAttribute('aria-label') || '').startsWith(name)) return item;
            }
            return false;
        }, 10000);
        await openFile('generated/output.ts');
        await browser.driver.actions().doubleClick(await tab('output.ts')).perform(); // retain the tab when another file opens
        const generated = await row('generated');
        if (await generated.getAttribute('aria-expanded') === 'true') {
            await (await generated.findElement(By.css('.monaco-tl-twistie'))).click();
        }
        await (await new ActivityBar().getViewControl('Explorer')).openView();
        const editor = await browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.editor-instance .monaco-editor .view-lines'))) {
                if (await item.isDisplayed()) return item;
            }
            return false;
        }, 10000);
        await browser.driver.actions().contextClick(editor).perform();
        await selectReveal('Included editor must offer reveal');
        await browser.driver.wait(async () => (await row('output.ts')).getAttribute('aria-selected').then(value => value === 'true'), 10000);
        await browser.takeScreenshot('reveal-from-editor');

        await openFile('other.txt'); // unchanged, absent from the comparison
        await browser.driver.actions().contextClick(await tab('other.txt')).perform();
        await browser.driver.wait(async () => (await menuItems()).length > 0, 10000);
        assert.equal(await menuItem(), false, 'An unchanged file must not offer reveal');
        assert.equal(await menuItem(diffTitle), false, 'An unchanged file must not offer the comparison diff');
        await browser.driver.actions().sendKeys(Key.ESCAPE).perform();
        await (await new ActivityBar().getViewControl('Explorer')).openView();
        // Right-click a different tab: the command must use that tab's URI.
        await browser.driver.actions().contextClick(await tab('output.ts')).perform();
        await selectReveal('Included inactive tab must offer reveal');
        await browser.driver.wait(async () => (await row('output.ts')).getAttribute('aria-selected').then(value => value === 'true'), 10000);
        await browser.takeScreenshot('reveal-from-inactive-tab');

        const expectDiff = async () => {
            await browser.driver.wait(async () => {
                const active = await browser.driver.findElements(By.css('.tab.active'));
                return (await Promise.all(active.map(tab => tab.getAttribute('aria-label'))))
                    .some(label => label?.startsWith('example.txt (Working Tree)'));
            }, 10000, 'The comparison diff for the requested file must be active');
            await browser.driver.wait(async () => {
                for (const diff of await browser.driver.findElements(By.css('.monaco-diff-editor'))) {
                    if (await diff.isDisplayed()) return true;
                }
                return false;
            }, 10000);
        };
        await openFile('example.txt');
        await browser.driver.actions().doubleClick(await tab('example.txt')).perform();
        const lines = await browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.editor-instance .monaco-editor .view-lines'))) {
                if (await item.isDisplayed()) return item;
            }
            return false;
        }, 10000);
        await browser.driver.actions().contextClick(lines).perform();
        await browser.driver.wait(() => menuItem(diffTitle), 10000);
        await browser.takeScreenshot('open-comparison-diff-menu');
        await selectReveal('Included editor must offer the comparison diff', diffTitle);
        await expectDiff();

        await openFile('other.txt');
        await browser.driver.actions().contextClick(await tab('example.txt')).perform();
        await selectReveal('Included inactive tab must offer the comparison diff', diffTitle);
        await expectDiff();
        await browser.takeScreenshot('open-comparison-diff-from-inactive-tab');
    });

    it('restores review progress after a full restart and retains the approved hash after edits', async () => {
        const checkbox = async () => (await row('example.txt')).findElement(By.css('[role="checkbox"]'));
        // Read each render atomically: refreshing the tree legitimately replaces rows.
        const checkedState = () => browser.driver.executeScript(() => {
            for (const row of document.querySelectorAll('.customview-tree .monaco-list-row')) {
                if (row.querySelector('.label-name')?.textContent === 'example.txt') {
                    return row.querySelector('[role="checkbox"]')?.getAttribute('aria-checked');
                }
            }
            return null;
        });
        const noise = path.join(process.env.GTC_TEST_REPOSITORY, 'agent-active.txt');
        let writing = true, writes = 0;
        const writer = (async () => {
            while (writing) {
                await fs.writeFile(noise, `agent edit ${++writes}\n`);
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        })();
        try {
            await (await checkbox()).click();
            await new Workbench().executeCommand('Git Tree Compare: Refresh');
            await browser.driver.wait(async () => (await checkedState()) === 'true', 15000,
                'The review must persist while an agent continues editing unrelated files');
            assert.ok(writes > 1);
            await browser.takeScreenshot('approval-during-agent-edits');
        } finally {
            writing = false;
            await writer;
            await fs.unlink(noise);
        }
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
        await browser.driver.wait(async () => (await checkedState()) === 'true', 15000,
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
        await openFile('example.txt');
        await new Workbench().executeCommand('View: Close Editor');
        await new Workbench().executeCommand('Git Tree Compare: Refresh');
        await browser.driver.wait(async () => (await checkedState()) === 'true', 15000);
        const flicker = await browser.driver.executeScript(() => {
            window.reviewObserver.disconnect();
            return window.reviewFlicker;
        });
        assert.deepEqual(flicker, [], 'Switching views or closing an editor must not briefly render reviewed files unchecked');
        const file = path.join(process.env.GTC_TEST_REPOSITORY, 'example.txt');
        await fs.writeFile(file, 'changed by an agent after review\n');
        await browser.driver.wait(async () => (await checkedState()) === 'false', 15000,
            'An external edit must invalidate the review');
        const reviewColour = () => browser.driver.executeScript(() => {
            for (const row of document.querySelectorAll('.customview-tree .monaco-list-row')) {
                const label = row.querySelector('.label-name');
                if (label?.textContent === 'example.txt') return getComputedStyle(label).color;
            }
            return null;
        });
        await browser.driver.wait(async () => (await reviewColour()) === 'rgb(223, 165, 255)', 15000,
            'A changed approval must have the dedicated review colour');
        await browser.driver.actions().clear();
        await browser.driver.actions().move({ origin: await row('example.txt') }).perform();
        const diffAction = await browser.driver.wait(async () => {
            const actions = await (await row('example.txt')).findElements(By.css('[aria-label="View Diff Since Last Reviewed"]'));
            for (const action of actions) if (await action.isDisplayed()) return action;
            return false;
        }, 10000, 'The incremental diff action must be beside the existing file actions');
        await diffAction.click();
        await browser.driver.wait(async () => {
            const tabs = await browser.driver.findElements(By.css('.tab.active'));
            for (const tab of tabs) if ((await tab.getAttribute('aria-label') || '').includes('Last reviewed commit')) return true;
            return false;
        }, 10000, 'The native diff must identify the last reviewed commit baseline');
        await browser.takeScreenshot('changed-since-review-diff');
        await fs.writeFile(file, 'working changes\n');
        await browser.driver.wait(async () => (await checkedState()) === 'true', 15000,
            'Restoring the approved version must restore its check');
        await browser.driver.wait(async () => (await reviewColour()) !== 'rgb(223, 165, 255)', 10000,
            'Restoring the approval must remove the review colour');
    });

    it('restores the saved Orca note after the full editor restart', async () => {
        await openFile('committed.txt');
        const glyph = await browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.comment-range-glyph.comment-thread'))) {
                if (await item.isDisplayed()) return item;
            }
            return false;
        }, 10000, 'The saved thread must be restored');
        await glyph.click();
        await browser.driver.wait(async () => {
            for (const item of await browser.driver.findElements(By.css('.review-widget'))) {
                if (await item.isDisplayed() && (await item.getText()).includes('Saved review draft')) return true;
            }
            return false;
        }, 10000, 'The restored draft must contain the original feedback');
        await browser.takeScreenshot('orca-draft-restored');
    });

    it('selects review and branch bases from collapsed panes without losing the full PR timeline', async () => {
        await (await new ActivityBar().getViewControl('Git Tree Compare')).openView();
        const section = async label => {
            const header = await browser.driver.wait(async () => {
                const headers = await browser.driver.findElements(By.css(`.pane-header[aria-label^="${label}"][aria-label$=" Section"]`));
                for (const item of headers) if (await item.isDisplayed()) return item;
                return false;
            }, 15000, `${label} must be ready after activation`);
            if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
            return header.findElement(By.xpath('..'));
        };
        const inSection = async (pane, label) => browser.driver.wait(async () => {
            for (const candidate of await pane.findElements(By.css('.monaco-list-row'))) {
                for (const name of await candidate.findElements(By.css('.label-name'))) {
                    if (await name.getText() === label && await candidate.isDisplayed()) return candidate;
                }
            }
            return false;
        }, 15000, `${label} must be visible in its pane`);
        const bases = await section('Compare From');
        await inSection(bases, 'Latest review activity');
        await inSection(bases, 'Branch merge-base');
        await inSection(bases, 'main');
        const origin = await inSection(bases, 'origin/main');
        await origin.click();
        await browser.takeScreenshot('review-base-candidates');
        const commits = await section('PR Commits');
        const feature = await inSection(commits, 'Feature');
        await feature.click();
        const main = await section('repository');
        await browser.driver.wait(async () => {
            const labels = await main.findElements(By.css('.monaco-list-row .label-name'));
            const names = await Promise.all(labels.map(label => label.getText()));
            return names.some(name => name.startsWith('Feature ·')) && !names.includes('committed.txt') && names.includes('example.txt');
        }, 15000, 'Choosing HEAD must show only changes after HEAD');
        assert.ok(await inSection(commits, 'Feature'), 'The base commit remains in the PR timeline');
        await browser.takeScreenshot('review-base-selected-commit');
        await browser.quit();
        const profile = path.join(process.env.TEST_RESOURCES, 'restart-profile');
        await fs.rm(profile, { recursive: true, force: true });
        await fs.cp(path.join(process.env.TEST_RESOURCES, 'settings'), profile, {
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
        const restored = await section('repository');
        await browser.driver.wait(async () => {
            const labels = await restored.findElements(By.css('.monaco-list-row .label-name'));
            return (await Promise.all(labels.map(label => label.getText()))).some(name => name.startsWith('Feature ·'));
        }, 15000, 'The exact chosen base must survive restarting VS Code');
        await inSection(await section('Compare From'), 'Latest review activity');
        await browser.takeScreenshot('review-base-restored');
        await new Workbench().executeCommand('Git Tree Compare: Reset Comparison Base');
    });

});
