/** 独立质量合同绑定实际实现、模型与预算；不签发产品自动采纳权限。 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DEFAULT_L2_SCENARIO_BUDGET,type L2ScenarioBudget} from '../memory/layered/l2-scenario-workspace.ts';

export type QualityRow=Record<string,any>;
export type OrganizationQualityBudget=L2ScenarioBudget&{max_profile_entries:number};
export interface OrganizationQualityContract {
  provider:string; request_model:string; verifier_provider:string; verifier_model:string;
  rules_version:string; prompt_version:string; schema_version:string; purpose_version:string;
  input_projection_version:string; evaluation_version:string; budget:OrganizationQualityBudget;
}
export const FACT_PREPARATION_DATASET_VERSION='fact-correction-path-preparation-v1';
export const QUALITY_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEMANTIC_DIMENSIONS=['subject','negation','time','plan','condition','conflict','correction','stability'] as const;
export const REQUIRED_PHASES=['l2_proposal','l2_verification','l3_proposal','l3_verification','l2_challenge','l3_challenge'] as const;
export type OrganizationQualityPhase=typeof REQUIRED_PHASES[number];

export class OrganizationQualityError extends Error {
  readonly code:string;readonly status:number;
  constructor(code='quality_request_invalid',status=400){super(code);this.code=code;this.status=status;}
}
export function qualityObject(value:unknown):value is QualityRow {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
export function qualityKeys(value:unknown,keys:readonly string[]):value is QualityRow {
  return qualityObject(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
export function qualityJSON(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(qualityJSON).join(',')}]`;
  if(qualityObject(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${qualityJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function qualityDigest(value:unknown):string {
  return createHash('sha256').update(qualityJSON(value),'utf8').digest('hex');
}
export function qualitySpacedJSON(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(qualitySpacedJSON).join(', ')}]`;
  if(qualityObject(value))return `{${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)}: ${qualitySpacedJSON(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}
export function qualityConflict():never {throw new OrganizationQualityError('quality_input_changed',409);}
export function qualityMissing():never {throw new OrganizationQualityError('quality_evidence_not_found',404);}
export function qualityInvalid():never {throw new OrganizationQualityError();}

function sourceIdentity(names:string[]):string {
  const sources=names.sort().map(name=>[name,qualityDigest(readFileSync(new URL(name,import.meta.url),'utf8'))]);
  return qualityDigest(Object.fromEntries(sources));
}
export function createOrganizationQualityContract(overrides:Partial<OrganizationQualityContract>={}):OrganizationQualityContract {
  const organization=['../memory/layered/l2-scenario-workspace.ts','../memory/layered/l3-profile-workspace.ts','../memory/layered/l2-scenario-service.ts','../memory/layered/l3-profile-service.ts',
    '../memory/layered/layered-memory-management-source-policy.ts','../memory/layered/layered-memory-management-target.ts'];
  const rules=sourceIdentity(organization);
  const contract:OrganizationQualityContract={provider:'unconfigured',request_model:'unconfigured',
    verifier_provider:'unconfigured',verifier_model:'unconfigured',rules_version:rules,prompt_version:rules,
    schema_version:rules,purpose_version:'layered-background-v1',input_projection_version:'scope-projection-correction-v3',
    evaluation_version:sourceIdentity(['organization-quality-contract.ts','organization-quality-snapshot.ts',
      'organization-quality-store.ts','organization-quality-service.ts','organization-quality-review.ts','organization-quality-report.ts',
      'organization-quality-runtime.ts','organization-quality-api.ts','quality-model-authorization.ts','quality-model-caller.ts']),
    budget:{...DEFAULT_L2_SCENARIO_BUDGET,max_profile_entries:16},...structuredClone(overrides)};
  if(Object.values(contract).some(value=>typeof value==='string'&&!value)
    ||Object.values(contract.budget).some(value=>!Number.isSafeInteger(value)||value<1)
    ||contract.budget.max_model_calls<2||contract.budget.max_model_calls>16)qualityInvalid();
  return contract;
}
