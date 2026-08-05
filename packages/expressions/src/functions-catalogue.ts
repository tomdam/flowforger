/**
 * Catalogue of known expression-language function names (lowercase).
 *
 * Contents: every function the FlowForger engine implements (including
 * aliases), plus documented Power Automate / Logic Apps functions the local
 * engine does not implement. Consumers (validator, language service) treat
 * membership as "this name is a real function"; absence as "probable typo".
 *
 * The engine's corpus test pins registry ⊆ KNOWN_FUNCTIONS, so adding a
 * function to the engine without listing it here fails the engine suite.
 */

export const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set([
  // References
  'variables', 'body', 'actionbody', 'outputs', 'actions', 'action',
  'item', 'items', 'trigger', 'triggerbody', 'triggeroutputs',
  'workflow', 'parameters', 'iterationindexes', 'listcallbackurl', 'result',
  'formdatavalue', 'formdatamultivalues', 'multipartbody',
  'triggerformdatavalue', 'triggerformdatamultivalues', 'triggermultipartbody',
  // Comparison / logical / conditional
  'equals', 'greater', 'less', 'greaterorequals', 'ge', 'lessorequals', 'le',
  'and', 'or', 'not', 'if', 'coalesce',
  'contains', 'startswith', 'endswith', 'empty', 'bool', 'isfloat', 'isint',
  // Strings
  'concat', 'substring', 'replace', 'tolower', 'toupper', 'trim',
  'split', 'join', 'indexof', 'lastindexof', 'nthindexof', 'guid',
  'string', 'length', 'slice', 'chunk', 'formatnumber',
  // Collections / objects
  'json', 'createarray', 'array', 'first', 'last', 'skip', 'take',
  'union', 'intersection', 'range', 'sort', 'reverse',
  'addproperty', 'setproperty', 'removeproperty',
  // Math
  'add', 'sub', 'mul', 'div', 'mod', 'min', 'max', 'rand',
  'int', 'float', 'abs', 'ceil', 'floor', 'round', 'decimal',
  // Date/time
  'utcnow', 'parsedatetime', 'formatdatetime',
  'adddays', 'addhours', 'addminutes', 'addseconds',
  'addtotime', 'subtractfromtime', 'getfuturetime', 'getpasttime',
  'ticks', 'dayofmonth', 'dayofweek', 'dayofyear',
  'startofday', 'startofhour', 'startofmonth', 'datedifference',
  'convertfromutc', 'converttoutc', 'converttimezone',
  // Encoding / URI / binary / XML
  'base64', 'base64tostring', 'decodebase64', 'base64tobinary', 'binary',
  'datauri', 'datauritostring', 'datauritobinary', 'decodedatauri',
  'uricomponent', 'uricomponenttostring', 'encodeuricomponent',
  'decodeuricomponent', 'uricomponenttobinary',
  'xml', 'xpath',
  'urihost', 'uripath', 'uripathandquery', 'uriport', 'uriquery', 'urischeme',
  // Documented cloud functions the local engine does not implement
  'actionoutputs', 'appsetting',
]);
