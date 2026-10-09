if (!process.send || !/^[a-f\d]{64}$/.test(process.env.NOTALONE_PAGE_RUN_NONCE ?? '')) throw new Error('page_test_unapproved');
const nonce = process.env.NOTALONE_PAGE_RUN_NONCE;
const uncertain = process.argv[3] === 'true';
const finish = () => {
  clearTimeout(timer);
  process.send({ nonce, cleanupConfirmed: !uncertain });
  process.disconnect();
  process.exitCode = uncertain ? 1 : 0;
};
process.on('SIGTERM', finish); process.on('SIGINT', finish);
const timer = setTimeout(finish, Number(process.argv[2]));
process.send({ nonce, ready: true });
