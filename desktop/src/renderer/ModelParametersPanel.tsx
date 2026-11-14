import { useState } from 'react';
import { DEFAULT_MODEL_PARAMETERS, equalModelParameters, isModelParameters, type ModelParameters, type ModelThinkingEffort } from '../shared/model-parameters';
import type { SetupState } from '../shared/setup-bridge';
import { useSettingsDraft } from './use-settings-draft';

export function ModelParametersPanel({ state }: { state: SetupState }) {
  const baseline = state.modelParameters ?? DEFAULT_MODEL_PARAMETERS;
  const [parameters = baseline, setParameters, discard, saving, save] = useSettingsDraft<ModelParameters>('setup-model-parameters', baseline);
  const [error, setError] = useState('');
  const dirty = state.modelParametersInvalid === true || !equalModelParameters(parameters, baseline);
  const valid = isModelParameters(parameters);
  const update = (kind: 'reply' | 'memory', changes: Partial<ModelParameters['reply']>) => {
    setError('');
    setParameters({ ...parameters, [kind]: { ...parameters[kind], ...changes } });
  };
  return <form className="model-parameters-form" aria-label="模型参数" onSubmit={event => {
    event.preventDefault();
    if (saving || !dirty || !valid) return;
    const submitted = structuredClone(parameters);
    setError('');
    void save(() => window.notalone.setup.saveModelParameters(submitted)).then(() => discard())
      .catch(() => setError('模型参数未能保存，请重试。'));
  }}>
    <h3>模型参数</h3>
    {state.modelParametersInvalid && <p role="alert">已保存的模型参数无效。下方显示待设置的默认值，尚未生效；请重新选择并保存。</p>}
    <div className="model-parameters-groups">
      {(['reply', 'memory'] as const).map(kind => {
        const title = kind === 'reply' ? '回复生成' : '记忆处理';
        const value = parameters[kind];
        return <fieldset key={kind} disabled={saving}>
          <legend>{title}</legend>
          <label htmlFor={`${kind}-thinking-effort`}>{title}思考程度</label>
          <select id={`${kind}-thinking-effort`} value={value.thinkingEffort}
            onChange={event => update(kind, { thinkingEffort: event.target.value as ModelThinkingEffort })}>
            <option value="off">关闭</option>
            <option value="low">低</option>
            <option value="high">高</option>
            <option value="max">最高</option>
          </select>
          <label htmlFor={`${kind}-temperature`}>{title}温度</label>
          <input id={`${kind}-temperature`} type="number" min="0" max="2" step="any"
            value={Number.isFinite(value.temperature) ? value.temperature : ''}
            disabled={value.thinkingEffort !== 'off'} aria-describedby={`${kind}-temperature-help`}
            onChange={event => update(kind, { temperature: event.target.value === '' ? NaN : Number(event.target.value) })} />
          <p id={`${kind}-temperature-help`}>{value.thinkingEffort === 'off'
            ? '温度范围 0–2。' : '开启思考时，DeepSeek 忽略所设温度并固定为 1；关闭思考后使用已保存的温度。'}</p>
        </fieldset>;
      })}
    </div>
    <p>记忆处理参数用于提取、核验、裁决以及场景和画像整理。保存后会重新加载本机服务，无需重新输入密钥。</p>
    <div className="model-parameters-actions">
      <button className="button primary" type="submit" disabled={saving || !dirty || !valid}>{saving ? '正在保存模型参数…' : '保存模型参数'}</button>
      <button className="button" type="button" disabled={saving || equalModelParameters(parameters, baseline)} onClick={() => { discard(); setError(''); }}>撤销更改</button>
      {dirty && <span role="status">有未保存的更改</span>}
    </div>
    {!valid && <p role="alert">温度须为 0 到 2 之间的数字。</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
