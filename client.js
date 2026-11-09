/**
 * dsh-md-convert — 浏览器半区(dsh.client)
 *
 * 在「插件」页给本 bundle 注册配置卡(DSH 0.2.0 起内联在插件详情页「说明」下方):
 * 可查看/修改转换缓存目录、启用开关、容量上限与保留天数,并可调用宿主目录选择器。
 *
 * 设置面注册遵循宿主约定:bundle 槽可用时不再注册 row 槽(同一份表单不留两个入口);
 * 旧宿主没有 bundle 槽时回退到 row 的「>」二级页。
 * 读写走 host 半区的 /dsh-md-convert/api/v1/settings(经 configEditor 持久化)。
 * 样式只用 `--dsw-alias-*` 主题 token,跟随宿主明暗主题。
 */
window.__ModuleLoader__.load({
  id: 'dsh-md-convert',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-md-convert/api/v1/settings';
    const CACHE_DEFAULTS = { enabled: true, dir: '', maxBytes: 2 * 1024 * 1024 * 1024, maxAgeDays: 0 };

    const surface = {
      height: '32px',
      boxSizing: 'border-box',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '6px',
      outline: 'none',
    };

    const ui = {
      wrap: { display: 'grid', gap: '14px', maxWidth: '640px', padding: '2px 0 6px' },
      field: { display: 'grid', gap: '6px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: { ...surface, flex: '1 1 300px', minWidth: '220px', padding: '0 10px' },
      number: { ...surface, width: '168px', padding: '0 10px' },
      button: {
        ...surface,
        padding: '0 14px',
        cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      primary: {
        ...surface,
        padding: '0 16px',
        cursor: 'pointer',
        color: '#fff',
        background: 'var(--dsw-alias-brand-primary)',
        borderColor: 'var(--dsw-alias-brand-primary)',
      },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
    };

    function formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
      if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
      if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
      return `${n} B`;
    }

    function CacheSettingsCard(props) {
      const view = props.view;
      const pick = typeof props.pick === 'function' ? props.pick : null;
      const [form, setForm] = React.useState(CACHE_DEFAULTS);
      const [effectiveDir, setEffectiveDir] = React.useState('');
      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const alive = React.useRef(true);

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(ROUTE, { headers: { accept: 'application/json' } });
          const data = await res.json().catch(() => null);
          if (!alive.current) return;
          if (!data || data.ok !== true) throw new Error((data && data.error) || `读取设置失败(HTTP ${res.status})`);
          setForm({ ...CACHE_DEFAULTS, ...data.cache });
          setEffectiveDir(data.effectiveDir || '');
          setStatus(data.status || null);
          setError('');
        } catch (e) {
          if (alive.current) setError(e && e.message ? e.message : String(e));
        } finally {
          if (alive.current) setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        alive.current = true;
        load();
        return () => {
          alive.current = false;
        };
      }, [load]);

      const change = (patch) => {
        setForm((prev) => ({ ...prev, ...patch }));
        setNotice('');
      };

      const save = async () => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          const res = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cache: form }),
          });
          const data = await res.json().catch(() => null);
          if (!data || data.ok !== true) throw new Error((data && data.error) || `保存失败(HTTP ${res.status})`);
          if (!alive.current) return;
          setForm({ ...CACHE_DEFAULTS, ...data.cache });
          setEffectiveDir(data.effectiveDir || '');
          setNotice('已保存,插件会按新配置重新加载');
        } catch (e) {
          if (alive.current) setError(e && e.message ? e.message : String(e));
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const browse = async () => {
        if (!pick) {
          setError('当前宿主不支持目录选择,请手动填写路径');
          return;
        }
        try {
          const dir = await pick();
          if (typeof dir === 'string' && dir.trim() !== '') change({ dir });
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      };

      if (view === 'summary') {
        return h('span', { style: ui.meta }, `转换缓存:${form.dir ? form.dir : '默认目录'}`);
      }

      if (loading) return h('div', { style: ui.meta }, '读取设置…');

      return h(
        'div',
        { style: ui.wrap },
        h(
          'label',
          { style: ui.row },
          h('input', {
            type: 'checkbox',
            checked: form.enabled === true,
            onChange: (e) => change({ enabled: e.target.checked }),
          }),
          h('span', { style: ui.label }, '启用转换缓存(同一文件内容未变时直接复用,不再重转)'),
        ),
        h(
          'div',
          { style: ui.field },
          h('span', { style: ui.label }, '缓存目录(留空使用默认目录)'),
          h(
            'div',
            { style: ui.row },
            h('input', {
              type: 'text',
              style: ui.input,
              value: form.dir,
              placeholder: '默认:$DSH_HOME/md-convert-cache',
              onChange: (e) => change({ dir: e.target.value }),
            }),
            h('button', { type: 'button', style: ui.button, onClick: browse }, '浏览…'),
            h('button', { type: 'button', style: ui.button, onClick: () => change({ dir: '' }) }, '恢复默认'),
          ),
          effectiveDir ? h('span', { style: ui.hint }, `当前生效:${effectiveDir}`) : null,
        ),
        h(
          'div',
          { style: ui.field },
          h('span', { style: ui.label }, '容量上限(字节,0 = 不限)'),
          h('input', {
            type: 'number',
            min: 0,
            step: 1,
            style: ui.number,
            value: form.maxBytes,
            onChange: (e) => change({ maxBytes: Number(e.target.value) }),
          }),
        ),
        h(
          'div',
          { style: ui.field },
          h('span', { style: ui.label }, '最长保留天数(0 = 不限)'),
          h('input', {
            type: 'number',
            min: 0,
            step: 1,
            style: ui.number,
            value: form.maxAgeDays,
            onChange: (e) => change({ maxAgeDays: Number(e.target.value) }),
          }),
        ),
        status
          ? h('span', { style: ui.meta }, `当前缓存:${status.entries} 个条目,占用 ${formatBytes(status.bytes)}`)
          : null,
        h(
          'div',
          { style: ui.row },
          h('button', { type: 'button', style: ui.primary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          error ? h('span', { style: ui.err }, error) : null,
          notice ? h('span', { style: ui.ok }, notice) : null,
        ),
        h('span', { style: ui.hint }, '空目录 = 默认位置;保存后插件按新配置重新加载,已转换过的文件仍会命中缓存。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;

        // 目录选择器在点击时再取:客户端服务可能晚于本插件就绪。
        const injected = () => ({
          pick: async () => {
            const uiWorkspace = ctx.get('uiWorkspace');
            if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
              throw new Error('当前宿主不支持目录选择,请手动填写路径');
            }
            return await uiWorkspace.pickDirectory();
          },
        });

        const bundleKey = 'dsh-md-convert';
        const rowKey = 'dsh-md-convert#dsh-md-convert';
        let bundleLive = false;
        let disposeRow = null;

        slots.inject('plugins.bundle.config', () => {
          bundleLive = true;
          if (typeof disposeRow === 'function') {
            disposeRow();
            disposeRow = null;
          }
          return slots.register(
            { name: 'plugins.bundle.config', key: bundleKey, inject: injected },
            CacheSettingsCard,
          );
        });

        // 旧宿主(无 bundle 槽)回退:row 的「>」二级页;新宿主上不注册,避免两个入口
        slots.inject('plugins.row.config', () => {
          if (bundleLive) return undefined;
          disposeRow = slots.register(
            { name: 'plugins.row.config', key: rowKey, inject: injected },
            CacheSettingsCard,
          );
          return disposeRow;
        });
      },
    };
  },
});
