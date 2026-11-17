/**
 * Shared vocabulary for the core: byte order and the problem record that both
 * the evaluator and the UI speak.
 */

export type Endian = 'little' | 'big';

export interface Problem {
  severity: 'error' | 'warn';
  /** 稳定原因码（`NO_SOURCE` / `CYCLE` …）：过滤与测试只认它，不解析文案 */
  code?: string;
  nodeKey?: string;
  fieldId?: string;
  /** 可选定位：出问题的端口与地址 */
  port?: string;
  addr?: number;
  message: string;
  detail?: string;
  /** 可选修复动作，供问题面板直接执行 */
  fix?: { label: string; kind: string };
}
