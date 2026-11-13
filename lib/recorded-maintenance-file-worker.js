'use strict';

// Private child of Operator. No network listener and no independent job queue.
const { createFiles, fail } = require('./recorded-maintenance-files');
process.once('message', async input => {
  try {
    const files = createFiles(input.root, input.config);
    const target = files.target(input.id);
    if (target.identity !== input.identity) fail('受付後に録画履歴が変わりました。状態確認をやり直してください。');
    const beforeCommit = () => new Promise((resolve, reject) => {
      process.once('message', message => message.commit === true ? resolve() : reject(new Error('反映の承認応答が不正です。')));
      process.send({ phase: 'commit' });
    });
    let result;
    switch (input.action) {
      case 'inspect': result = await files.inspect(target); break;
      case 'autoThumbnailSource': result = await files.inspect(target, { saveMissing: true, beforeCommit }); break;
      case 'assertFile': {
        result = await files.assertFile(target, { fingerprint: input.fingerprint });
        break;
      }
      case 'verify': result = await files.verify(target, input.path); break;
      case 'apply': {
        const updated = await files.apply(target, input.ticket, beforeCommit);
        result = { path: updated.program.recorded };
        break;
      }
      case 'search': result = await files.search(target, input.selectedIds, () => {
        if (Date.now() > input.deadline) fail('捜索期限に達しました。録画先を絞って再実行してください。');
      }, beforeCommit); break;
      default: fail('個別確認の操作が不正です。', 'invalid_request');
    }
    process.send({ ok: true, result }, () => process.disconnect());
  } catch (error) {
    process.send({ ok: false, message: error.publicMessage || error.message }, () => process.disconnect());
  }
});
