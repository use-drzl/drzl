const { router } = await import('./src/generated/api/index.ts');
const names = Object.keys(router);
if (!names.length) {
  console.error('FAIL: the generated router barrel exports nothing.');
  process.exit(1);
}
console.log('    loaded ' + names.length + ' routers: ' + names.sort().join(', '));
