import { data } from './helpers.js';

export async function healthRoutes(app) {
  app.get('/api/v1/health/live', async (request, reply) => data(reply, request, { status: 'ok' }));
  app.get('/api/v1/health/ready', async (request, reply) => {
    const database = await app.readiness.database();
    const objects = await app.readiness.objects();
    const backup = await app.readiness.backup();
    const components = { database, objects, backup };
    const values = Object.values(components);
    const status = values.includes('down') ? 'down' : values.includes('degraded') ? 'degraded' : 'ok';
    if (status === 'down') reply.code(503);
    return data(reply, request, { status, components });
  });
}
