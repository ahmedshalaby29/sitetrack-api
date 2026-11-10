import { AppError, ErrorCode } from '../../lib/errors.js';
import type { DeliveriesRepo } from './repo.js';
import type {
  DeliveryDirection,
  DeliveryListResponse,
  DeliveryResponse,
  ListCompanyDeliveriesQuery,
} from './schemas.js';

export class DeliveriesService {
  constructor(private readonly repo: DeliveriesRepo) {}

  async listDeliveries(opts: {
    projectId?: number | undefined;
    query: ListCompanyDeliveriesQuery;
  }): Promise<DeliveryListResponse> {
    return this.repo.listDeliveries(opts);
  }

  async getDelivery(deliveryId: number, expectedProjectId?: number): Promise<DeliveryResponse> {
    const delivery = await this.repo.getDeliveryById(deliveryId);
    if (!delivery) {
      throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
    }
    if (expectedProjectId !== undefined && delivery.projectId !== expectedProjectId) {
      throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
    }
    return delivery;
  }

  async initiateDelivery(params: {
    projectId: number;
    direction: DeliveryDirection;
    senderUserId: number;
    lines: { materialId: number; quantity: string }[];
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    return this.repo.initiateDelivery(params);
  }

  async recordDelivery(params: {
    deliveryId: number;
    receiverUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    return this.repo.recordDelivery(params);
  }

  async rejectDelivery(params: {
    deliveryId: number;
    receiverUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    return this.repo.rejectDelivery(params);
  }

  async cancelDelivery(params: {
    deliveryId: number;
    senderUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    return this.repo.cancelDelivery(params);
  }
}
