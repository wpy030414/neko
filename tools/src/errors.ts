/**
 * 统一的诊断类型：所有校验结果都表达为 Finding，便于逐条打印与断言。
 */
export type Severity = 'error' | 'warning';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
}

/** 结构性错误：无法继续执行时抛出，由 CLI 统一转成退出码 1。 */
export class AipError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'AipError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function errorFinding(code: string, message: string, at?: string): Finding {
  return at === undefined ? { code, severity: 'error', message } : { code, severity: 'error', message, path: at };
}

export function warningFinding(code: string, message: string, at?: string): Finding {
  return at === undefined ? { code, severity: 'warning', message } : { code, severity: 'warning', message, path: at };
}

export function fromError(err: unknown, code = 'INTERNAL'): Finding {
  if (err instanceof AipError) {
    return err.path === undefined
      ? { code: err.code, severity: 'error', message: err.message }
      : { code: err.code, severity: 'error', message: err.message, path: err.path };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code, severity: 'error', message };
}

export function formatFinding(finding: Finding): string {
  const label = finding.severity === 'error' ? 'ERROR' : 'WARN ';
  const at = finding.path === undefined ? '' : ` ${finding.path}`;
  return `${label} [${finding.code}]${at}: ${finding.message}`;
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}

export function countBy(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}
