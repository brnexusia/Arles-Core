import type { VerticalModule } from '../vertical.js';
import { beautyHandler } from './handler.js';
import { registerBeautyRoutes } from './routes.js';

export const beautyModule:VerticalModule={
  id:'beauty',name:'Arles Beauty',version:'1.0.0',
  capabilities:['beauty.appointments','beauty.services','beauty.professionals','beauty.availability','beauty.customers'],
  handle:context=>beautyHandler.handle(context),
  registerRoutes:registerBeautyRoutes
};

