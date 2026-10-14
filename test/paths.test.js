/**
 * paths.js 的测试 —— 根路径解析。
 *
 * 这里的每一条都对应真机上会静默出错的场景：解析错了不会报错，只会
 * 备份到空目录、或者把**别的 profile** 的文件打进包（真机实测发生过：
 * 在 `dsh web`（profile = web）实例上打的包，里面装的是 `profiles/desktop/*`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchEnvReader, profileNameFromContext, resolveRoots, rootsFromContext } from '../lib/paths.js';

/** 造一个只实现 `get(name, strict)` 的假 Context。 */
const fakeCtx = (services) => ({
  get(name, strict) {
    const hit = services[name];
    if (hit === undefined) {
      if (strict === false) return undefined;
      throw new Error(`service ${name} not found`);
    }
    return hit;
  },
});

const envSnapshot = (values) => ({
  get: (name) => (name in values ? { name, value: values[name] } : undefined),
});

test('resolveRoots：默认 profile 是 desktop，且各根都可被 overrides 整体覆盖', () => {
  const r = resolveRoots({ USERPROFILE: 'C:\\Users\\x' });
  assert.equal(r.profile, 'desktop');
  assert.equal(r.agentsSkills, 'C:\\Users\\x\\.agents\\skills');
  const o = resolveRoots({ USERPROFILE: 'C:\\Users\\x' }, { profile: 'web', dshHome: 'D:\\h' });
  assert.equal(o.profile, 'web');
  assert.equal(o.dshHome, 'D:\\h');
});

test('launchEnvReader：launchEnvironment 服务优先，进程环境兜底', () => {
  const read = launchEnvReader(fakeCtx({ launchEnvironment: envSnapshot({ DSH_HOME: 'D:\\from-service' }) }));
  assert.equal(read('DSH_HOME'), 'D:\\from-service');
  assert.equal(read('NO_SUCH_VAR'), undefined);

  const fallback = launchEnvReader(fakeCtx({}));
  assert.equal(fallback('DSH_HOME'), process.env.DSH_HOME);
});

test('★ profileNameFromContext：从 profileContext 服务取 profile 名', () => {
  assert.equal(profileNameFromContext(fakeCtx({ profileContext: { name: 'web', dir: 'D:\\p\\web' } })), 'web');
  assert.equal(profileNameFromContext(fakeCtx({ profileContext: { name: '  desktop  ' } })), 'desktop');
  assert.equal(profileNameFromContext(fakeCtx({})), undefined, '服务不在就是 undefined，不能抛');
  assert.equal(profileNameFromContext(fakeCtx({ profileContext: { name: '' } })), undefined);
  assert.equal(profileNameFromContext(fakeCtx({ profileContext: {} })), undefined);
  assert.equal(profileNameFromContext(null), undefined);
});

/**
 * ★ 这条是真机踩过的坑。
 *
 * `DSH_PROFILE` 由 dsh-shell-env 在**每次 shell 工具执行时**现算，宿主进程的
 * `process.env` 里没有它 → 旧实现永远落到 'desktop' 兜底。在 web profile 上跑时，
 * 插件会去读 desktop 的配置（包内容错），而只有 web profile 的机器上
 * `profiles/desktop` 不存在 → sanityOf 拒绝一切备份与导入。
 */
test('★ rootsFromContext：profile 名以 profileContext 为准，压过 DSH_PROFILE', () => {
  const ctx = fakeCtx({
    profileContext: { name: 'web', dir: 'D:\\p\\web' },
    launchEnvironment: envSnapshot({
      USERPROFILE: 'C:\\Users\\x',
      DSH_HOME: 'C:\\Users\\x\\.dsh',
      DSH_PROFILE: 'desktop', // 陈旧/错误的进程环境值
    }),
  });
  const r = rootsFromContext(ctx);
  assert.equal(r.profile, 'web', 'profileContext 是权威来源');
  assert.equal(r.dshHome, 'C:\\Users\\x\\.dsh');
});

test('rootsFromContext：没有 profileContext 时才退回 DSH_PROFILE，再退回 desktop', () => {
  const withEnv = fakeCtx({ launchEnvironment: envSnapshot({ DSH_PROFILE: 'web' }) });
  assert.equal(rootsFromContext(withEnv).profile, 'web');

  const bare = fakeCtx({ launchEnvironment: envSnapshot({}) });
  assert.equal(rootsFromContext(bare).profile, 'desktop');
});

test('rootsFromContext：overrides 依然最高优先（测试注入夹具根就靠它）', () => {
  const ctx = fakeCtx({ profileContext: { name: 'web' } });
  const r = rootsFromContext(ctx, { dshHome: 'D:\\fixture', profile: 'desktop' });
  assert.equal(r.dshHome, 'D:\\fixture');
  assert.equal(r.profile, 'desktop');
});
