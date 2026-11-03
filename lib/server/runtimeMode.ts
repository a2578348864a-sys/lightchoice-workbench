/**
 * 本地单用户运行时身份（Local Owner）。
 *
 * LightChoice Workbench V5 正式部署模型 = 本地单用户工作台：
 * 服务只绑定回环（127.0.0.1 / localhost），身份由服务端隐式建立，不存在账号 / 密码 / 访客。
 *
 * 历史说明：本模块曾以 `QX_RUNTIME_MODE` 区分 local_owner / public_showcase 两种运行模式，
 * 并由环境变量决定是否启用「无认证回环信任」。旧登录 / 密码 / 访客体系已删除：
 *   - 不再读取任何环境变量（`QX_RUNTIME_MODE` 运行时依赖 = 0）；
 *   - 缺少任何配置都不会回退到密码 / 登录体系；
 *   - 公开访客（public_showcase）能力已整体移除。
 *
 * 安全边界：本模块只决定「身份」。对象级授权（subject / owner / resource binding）、
 * CSRF / 同源、Evidence / Research / Decision 门禁均在各自模块独立执行，不因本模块而放宽。
 */
import "server-only";

export type RuntimeMode = "local_owner";

/** 当前正式运行模式恒为本地单用户。 */
export function getRuntimeMode(): RuntimeMode {
  return "local_owner";
}

/** 公开访客模式已移除，恒为 false。 */
export function isPublicShowcase(): boolean {
  return false;
}

/** 本地回环信任恒为启用：Local Owner 是唯一正式身份。 */
export function isLocalOwnerNoAuthTrust(): boolean {
  return true;
}
