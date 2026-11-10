import { StockRepo } from './repo.js';
import type {
  CompanyStockListResponse,
  ListCompanyStockQuery,
  ListProjectStoreQuery,
  ProjectStoreResponse,
  SingleStockResponse,
} from './schemas.js';

export class StockService {
  constructor(private readonly repo: StockRepo = new StockRepo()) {}

  async addStock(
    materialId: number,
    quantity: string,
  ): Promise<SingleStockResponse> {
    const stock = await this.repo.addStock(materialId, quantity);
    return { stock };
  }

  async setReorderPoint(
    materialId: number,
    reorderPoint: string,
  ): Promise<SingleStockResponse> {
    const stock = await this.repo.setReorderPoint(materialId, reorderPoint);
    return { stock };
  }

  async listCompanyStock(
    query: ListCompanyStockQuery,
  ): Promise<CompanyStockListResponse> {
    return this.repo.listCompanyStock(query);
  }

  async listProjectStore(
    projectId: number,
    query: ListProjectStoreQuery,
  ): Promise<ProjectStoreResponse> {
    return this.repo.listProjectStore(projectId, query);
  }
}
