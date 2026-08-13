import type { VerticalModule } from '../vertical.js';
import { deliveryHandler } from './handler.js';
import { registerDeliveryEventRoutes } from './event.routes.js';
import { handleDeliveryImage, handleDeliveryPendingInteraction } from './interactions.js';
import { registerDeliveryPanelRoutes } from './panel.routes.js';

export const deliveryModule: VerticalModule = {
  id: 'delivery',
  name: 'Arles Delivery',
  version: '2.0.0',
  capabilities: [
    'delivery.orders',
    'delivery.catalog',
    'delivery.customers',
    'delivery.store',
    'delivery.payments',
    'delivery.reviews'
  ],
  handle: context => deliveryHandler.handle(context),
  handlePendingInteraction: handleDeliveryPendingInteraction,
  handleImage: handleDeliveryImage,
  async registerRoutes(app) {
    await registerDeliveryPanelRoutes(app);
    await registerDeliveryEventRoutes(app);
  }
};
