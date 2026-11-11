export function withDiagnosticLock<T>(root:string,guard:()=>Promise<string>,work:()=>Promise<T>,timeoutMs?:number):Promise<T>;
