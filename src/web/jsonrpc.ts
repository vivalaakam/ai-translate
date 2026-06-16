/**
 * JSON-RPC 2.0 router for ai-translate.
 *
 * All API methods are registered here. The router validates requests,
 * dispatches to handlers, and returns standard JSON-RPC responses.
 *
 * Spec: https://www.jsonrpc.org/specification
 */

import { v4 as uuidv4 } from 'uuid';
import type { Response } from 'express';

// ─── JSON-RPC types ────────────────────────────────────────────────

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
  id?: string | number | null;
}

/** JSON-RPC 2.0 success response */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: any;
  id: string | number | null;
}

/** JSON-RPC 2.0 error response */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: {
    code: number;
    message: string;
    data?: any;
  };
  id: string | number | null;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Standard JSON-RPC error codes */
export const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const;

/** Application-level error codes (outside JSON-RPC reserved range) */
export const APP_ERRORS = {
  FILE_REQUIRED: { code: 10001, message: 'File is required' },
  TARGET_LANG_REQUIRED: { code: 10002, message: 'Target language is required' },
  BOOK_NOT_FOUND: { code: 10003, message: 'Book not found' },
  JOB_NOT_FOUND: { code: 10004, message: 'Job not found' },
  JOB_NOT_COMPLETE: { code: 10005, message: 'Translation not yet completed' },
  FILE_EXPIRED: { code: 10006, message: 'Output file expired' },
  ORIGINAL_FILE_NOT_FOUND: { code: 10007, message: 'Original file not found — re-upload the book' },
  API_UNAVAILABLE: { code: 10008, message: 'LLM API not available' },
  UPLOAD_FAILED: { code: 10009, message: 'Upload failed' },
} as const;

// ─── Handler types ────────────────────────────────────────────────

/** A JSON-RPC method handler function */
export type RpcMethodHandler = (params: Record<string, any>, context: RpcContext) => Promise<any> | any;

/** Context passed to every method handler — request-scoped resources */
export interface RpcContext {
  /** The uploaded file, if present (from multer) */
  file?: Express.Multer.File;
  /** Express response object (for streaming/file downloads) */
  res?: Response;
}

// ─── Router ───────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 method registry and dispatcher.
 */
export class JsonRpcRouter {
  private methods: Map<string, RpcMethodHandler> = new Map();
  schemas: Map<string, RpcMethodSchema> = new Map();

  /**
   * Register a JSON-RPC method.
   */
  register(method: string, handler: RpcMethodHandler, schema?: RpcMethodSchema): void {
    this.methods.set(method, handler);
    if (schema) this.schemas.set(method, schema);
  }

  /**
   * Handle a JSON-RPC request and return a response.
   */
  async handle(request: JsonRpcRequest, context: RpcContext): Promise<JsonRpcResponse> {
    const { id = null } = request;

    // Validate jsonrpc version
    if (request.jsonrpc !== '2.0') {
      return this.makeError(id, RPC_ERRORS.INVALID_REQUEST, 'Missing or invalid "jsonrpc" field');
    }

    // Validate method
    if (!request.method || typeof request.method !== 'string') {
      return this.makeError(id, RPC_ERRORS.INVALID_REQUEST, 'Missing or invalid "method" field');
    }

    const handler = this.methods.get(request.method);
    if (!handler) {
      return this.makeError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Method "${request.method}" not found`);
    }

    // Validate params
    const params = request.params ?? {};
    if (typeof params !== 'object' || Array.isArray(params)) {
      return this.makeError(id, RPC_ERRORS.INVALID_PARAMS, 'Params must be an object');
    }

    try {
      const result = await handler(params, context);
      return { jsonrpc: '2.0', result, id };
    } catch (err: any) {
      // If it's already an RpcError, use it directly
      if (err instanceof RpcError) {
        return this.makeError(id, { code: err.code, message: err.message }, err.data);
      }
      // Unknown error
      return this.makeError(id, RPC_ERRORS.INTERNAL_ERROR, err.message || 'Unknown error');
    }
  }

  /**
   * Get the JSON-RPC method discovery schema (for docs / method listing).
   */
  getDiscovery(): RpcMethodSchema[] {
    return Array.from(this.schemas.values());
  }

  private makeError(id: string | number | null, error: { code: number; message: string }, data?: any): JsonRpcErrorResponse {
    const response: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      error: { code: error.code, message: error.message },
      id,
    };
    if (data !== undefined) {
      response.error.data = data;
    }
    return response;
  }
}

// ─── RpcError ─────────────────────────────────────────────────────

/**
 * Application-level JSON-RPC error that handlers can throw.
 */
export class RpcError extends Error {
  code: number;
  data?: any;

  constructor(code: number, message: string, data?: any) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ─── Schema types ──────────────────────────────────────────────────

/** Schema definition for a JSON-RPC method (used for docs) */
export interface RpcMethodSchema {
  /** Method name (e.g. "book.list") */
  method: string;
  /** Human-readable description */
  description: string;
  /** Parameter definitions */
  params: Record<string, RpcParamSchema>;
  /** Return value description */
  result: RpcResultSchema;
}

/** Schema for a single parameter */
export interface RpcParamSchema {
  type: string;
  description: string;
  required?: boolean;
  default?: any;
  enum?: string[];
}

/** Schema for the result */
export interface RpcResultSchema {
  type: string;
  description: string;
  properties?: Record<string, { type: string; description: string }>;
}