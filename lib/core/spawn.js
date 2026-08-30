/**
 * dsh-md-convert — 异步子进程执行 helper
 *
 * 与 node:child_process 的 spawnSync 等价但**不阻塞事件循环**,供 DSH 插件
 * (agent 工具运行于宿主进程)场景下的长任务(pip 安装 / OCR / 模型下载)使用;
 * 独立 CLI 进程场景亦可统一使用。
 *
 * 返回结构与 spawnSync 对齐的 { status, signal, stdout, stderr, error }:
 *   - 正常结束:status 为退出码,error 为 undefined;
 *   - 超时/启动失败:status 为 null,error 为 "timeout" 或 spawn 的错误消息。
 */
import { spawn } from "node:child_process";

/**
 * 异步执行子进程并收集 stdout/stderr(有界)。
 * @param {string} cmd 可执行文件
 * @param {string[]} args 参数数组(不经过 shell,无注入)
 * @param {object} [opts]
 * @param {number} [opts.timeout=0] 超时毫秒;0 表示不超时
 * @param {number} [opts.maxBuffer] 单流最大收集字节数(默认 512MB)
 * @param {object} [opts.env] 环境变量(默认继承 process.env)
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string, error?: string}>}
 */
export function runAsync(cmd, args, opts = {}) {
	const { timeout = 0, maxBuffer = 512 * 1024 * 1024, windowsHide = true, env } = opts;
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { windowsHide, env });
		} catch (e) {
			resolve({ status: null, signal: null, stdout: "", stderr: "", error: e?.message ?? String(e) });
			return;
		}
		let stdout = "";
		let stderr = "";
		let outBytes = 0;
		let errBytes = 0;
		let settled = false;
		const finish = (r) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		const timer = timeout > 0
			? setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* 忽略 */ }
				finish({ status: null, signal: "SIGKILL", stdout, stderr, error: "timeout" });
			}, timeout)
			: null;
		const collect = (isErr) => (data) => {
			const chunk = data.toString();
			if (isErr) {
				errBytes += data.length;
				if (errBytes <= maxBuffer) stderr += chunk;
			} else {
				outBytes += data.length;
				if (outBytes <= maxBuffer) stdout += chunk;
			}
		};
		child.stdout?.on("data", collect(false));
		child.stderr?.on("data", collect(true));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			finish({ status: null, signal: null, stdout, stderr, error: e?.message ?? String(e) });
		});
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			finish({ status: code, signal, stdout, stderr });
		});
	});
}
