import { LIVE_BTW_RPC } from '@openchamber/sdk';
import { createCoordinator, type CoordinatorContext } from './runtime';

export default {
  id: 'openchamber-btw-coordinator',
  async setup(ctx: CoordinatorContext) {
    const coordinator = createCoordinator(ctx);
    await ctx.rpc.register(LIVE_BTW_RPC, coordinator.methods);
    await ctx.session.hook('context', coordinator.context);
    await ctx.session.hook('prompt', coordinator.prompt);
    return coordinator.dispose;
  },
};
