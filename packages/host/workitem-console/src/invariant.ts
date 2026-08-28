/**
 * WorkItem Console Host — 不变量注册
 *
 * 遵循 DSH 标准不变量模式，每个包导出一个 invariant 模块。
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-workitem-console'
const name = 'workitem-console-host-invariant'
const inject = ['invariants']

/** 本包无需运行时不变检查，安装为空操作 */
const install = () => {}

export const apply = (ctx: { invariants: { register: (name: string, install: () => void) => void } }) =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { name, inject, PACKAGE_NAME }