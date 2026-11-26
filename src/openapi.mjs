// OpenAPI 3.1 document describing the paid endpoints for agent discovery.
export function buildOpenApi(config) {
  const price = config.price ?? '$0.001';
  return {
    openapi: '3.1.0',
    info: {
      title: 'BSC Mint Radar',
      version: '1.0.0',
      description:
        'Live NFT contract intelligence for BNB Smart Chain (chainId 56): supply, free slots, mint price and Sourcify verification, read directly over JSON-RPC. Paid per request in USDC on Base via x402.',
      'x-x402-price': price,
    },
    servers: [{ url: config.publicBaseUrl ?? 'http://localhost:3000' }],
    paths: {
      '/v1/inspect': {
        get: {
          operationId: 'inspectContract',
          summary: 'Inspect one BSC NFT contract',
          description: 'Reads name, symbol, totalSupply, maxSupply, free slots, mint price and verification/safety flags for a single BSC contract. Cached 10 minutes. Paid: x402 USDC on Base.',
          parameters: [
            {
              name: 'address',
              in: 'query',
              required: true,
              schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              description: 'BSC contract address',
            },
          ],
          'x-payment-info': {
            price,
            protocol: 'x402',
            network: config.network ?? 'eip155:8453',
            asset: 'USDC',
            payTo: config.sellerAddress,
          },
          responses: {
            200: {
              description: 'Contract report',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/InspectResult' } } },
            },
            400: { description: 'Missing or invalid address', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            402: { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } } },
            502: { description: 'Upstream RPC unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/v1/batch': {
        get: {
          operationId: 'inspectBatch',
          summary: 'Inspect up to 10 BSC NFT contracts',
          description: 'Same report as /v1/inspect for up to 10 comma-separated addresses, fetched with bounded concurrency. Paid per request: x402 USDC on Base (flat price per call).',
          parameters: [
            {
              name: 'addresses',
              in: 'query',
              required: true,
              style: 'form',
              explode: false,
              schema: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
              description: 'Comma-separated contract addresses, max 10',
            },
          ],
          'x-payment-info': {
            price,
            protocol: 'x402',
            network: config.network ?? 'eip155:8453',
            asset: 'USDC',
            payTo: config.sellerAddress,
          },
          responses: {
            200: {
              description: 'Array of contract reports',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/InspectResult' }, maxItems: 10 },
                },
              },
            },
            400: { description: 'Missing, invalid, or more than 10 addresses', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            402: { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } } },
            502: { description: 'Upstream RPC unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        InspectResult: {
          type: 'object',
          required: ['address', 'chainId', 'sourcifyMatch', 'isFreeMint', 'fetchedAt'],
          properties: {
            address: { type: 'string' },
            name: { type: ['string', 'null'] },
            symbol: { type: ['string', 'null'] },
            chainId: { type: 'integer', const: 56 },
            totalSupply: { type: ['string', 'null'], description: 'Decimal string (uint256)' },
            maxSupply: { type: ['string', 'null'], description: 'Decimal string; null when no common maxSupply getter exists' },
            freeSlots: { type: ['string', 'null'], description: 'maxSupply - totalSupply when both known' },
            mintPriceWei: { type: ['string', 'null'] },
            mintPriceBNB: { type: ['number', 'null'] },
            priceFunction: { type: ['string', 'null'], description: 'Getter that produced the price' },
            isFreeMint: { type: 'boolean', description: 'true when price is 0 or no paying price getter exists' },
            sourcifyMatch: { type: 'string', enum: ['exact', 'match', 'partial', 'none'] },
            safety: {
              type: 'object',
              properties: {
                hasOwner: { type: ['boolean', 'string'], description: 'boolean, or "unknown" when ABI unavailable' },
                ownerCanPause: { type: ['boolean', 'string'], description: 'boolean, or "unknown" when ABI unavailable' },
              },
            },
            fetchedAt: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
        PaymentRequired: {
          type: 'object',
          properties: {
            x402Version: { type: 'integer' },
            accepts: { type: 'array', items: { type: 'object' } },
            error: { type: 'string' },
          },
        },
      },
    },
  };
}
