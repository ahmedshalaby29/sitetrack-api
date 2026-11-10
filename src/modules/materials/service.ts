import { AppError, ErrorCode } from '../../lib/errors.js';
import {
  MaterialsRepo,
  type ListMaterialsResult,
} from './repo.js';
import type {
  CreateMaterialBody,
  ListMaterialsQuery,
  MaterialResponse,
} from './schemas.js';

export class MaterialsService {
  constructor(private readonly repo: MaterialsRepo = new MaterialsRepo()) {}

  async createMaterial(input: CreateMaterialBody): Promise<MaterialResponse> {
    return this.repo.createMaterial(input);
  }

  async getMaterial(id: number): Promise<MaterialResponse> {
    const material = await this.repo.getMaterialById(id);
    if (!material) {
      throw new AppError(404, ErrorCode.MATERIAL_NOT_FOUND, 'Material not found');
    }
    return material;
  }

  async listMaterials(query: ListMaterialsQuery): Promise<ListMaterialsResult> {
    return this.repo.listMaterials(query);
  }
}
