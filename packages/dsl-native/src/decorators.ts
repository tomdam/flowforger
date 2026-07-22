/**
 * Decorator definitions for the native DSL.
 * These are marker decorators - their presence is detected at compile time
 * by the AST transformer, not at runtime. The decorator functions themselves
 * are no-ops that just return the target unchanged.
 */

// Trigger input types
export interface HttpTriggerOptions {
  method?: string;
  path?: string;
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface ManualTriggerOptions {
  schema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface RecurrenceTriggerOptions {
  frequency: 'Second' | 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month' | 'Year';
  interval: number;
  timeZone?: string;
  startTime?: string;
  schedule?: {
    minutes?: number[];
    hours?: number[];
    weekDays?: ('Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday')[];
    monthDays?: number[];
  };
}

export interface ConnectorTriggerOptions {
  connector: string;
  operation: string;
  params: Record<string, any>;
  connectionReferenceName?: string;
  splitOn?: string;
  recurrence?: {
    interval: number;
    frequency: string;
  };
}

/**
 * Class decorator that marks a class as a Flow definition.
 * This is a marker decorator - the transformer reads the decorator name and arguments from the AST.
 * @param name The name of the flow
 */
export interface FlowOptions {
  /** The name of the flow */
  name: string;
  /** Optional description for the flow */
  description?: string;
  /** Dataverse workflow GUID (used by `flowforger push` to identify the target flow) */
  workflowId?: string;
}

export function Flow(_nameOrOptions: string | FlowOptions): ClassDecorator {
  // No-op at runtime - the transformer reads this from the AST
  return function (target: Function) {
    return target;
  } as ClassDecorator;
}

/**
 * Method decorator for HTTP Request trigger.
 */
export function HttpTrigger(_options?: HttpTriggerOptions): MethodDecorator {
  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    return descriptor;
  };
}

/**
 * Method decorator for Manual (Button) trigger.
 */
export function ManualTrigger(_options?: ManualTriggerOptions): MethodDecorator {
  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    return descriptor;
  };
}

/**
 * Method decorator for Recurrence (scheduled) trigger.
 */
export function RecurrenceTrigger(_options?: RecurrenceTriggerOptions): MethodDecorator {
  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    return descriptor;
  };
}

/**
 * Method decorator for Connector-based triggers.
 */
export function ConnectorTrigger(_options: ConnectorTriggerOptions): MethodDecorator {
  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    return descriptor;
  };
}

/**
 * Method decorator that marks the main action method of a flow.
 */
export function Action(): MethodDecorator {
  return function (_target: any, _propertyKey: string | symbol, descriptor: PropertyDescriptor) {
    return descriptor;
  };
}
