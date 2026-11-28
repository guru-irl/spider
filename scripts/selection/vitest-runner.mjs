// SPDX-License-Identifier: MIT
import { TestRunner } from 'vitest';
import { isAbsolute, relative, sep } from 'node:path';

export default class RecordingRunner extends TestRunner {
  onBeforeCollect(files) {
    const tag = globalThis[Symbol.for('spider.selection.tag')];
    if (files.length !== 1 || !tag) throw new Error('The recorder needs one test file per fork and the coverage preload');
    const id = relative(process.env.SPIDER_SELECTION_ROOT || process.cwd(), files[0]);
    if (!id || isAbsolute(id) || id === '..' || id.startsWith(`..${sep}`)) throw new Error('The recorder test is outside the recording root');
    tag(id.split(sep).join('/'));
  }

  onAfterRunFiles() {
    super.onAfterRunFiles();
    // The forks pool may send SIGTERM while the worker is still alive and
    // before Node runs exit handlers. Persist the finished test here.
    globalThis[Symbol.for('spider.selection.finish')]();
  }
}
