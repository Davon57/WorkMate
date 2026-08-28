/**
 * WorkItem Console Client — 不变量注册
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workitem-console'
const name = 'client-ui-workitem-console-invariant'
const inject = ['invariants']

const install = () => {}

export const apply = (ctx: { invariants: { register: (name: string, install: () => void) => void } }) =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

export { name, inject, PACKAGE_NAME }