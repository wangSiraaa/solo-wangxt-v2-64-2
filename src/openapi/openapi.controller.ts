import { Controller, Get } from '@nestjs/common';
import { buildOpenApiDocument } from './openapi.document';

/** OpenAPI 3.0 文档（JSON），覆盖全部接口 */
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document() {
    return buildOpenApiDocument();
  }
}
