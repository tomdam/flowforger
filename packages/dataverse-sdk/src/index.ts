export interface DataverseClientOptions {
  baseUrl: string; // e.g., https://org.crm.dynamics.com
  token: string; // Bearer token
}

export interface ConnectionReferenceRecord {
  connectionreferenceid: string;
  connectionreferencelogicalname: string;
  connectionreferencedisplayname?: string;
  connectorid: string;
  statecode: number;
}

export class DataverseClient {
  private baseApi: string;
  private token: string;
  constructor(opts: DataverseClientOptions) {
    this.baseApi = `${opts.baseUrl.replace(/\/$/, '')}/api/data/v9.2`;
    this.token = opts.token;
  }

  private async request(path: string, init: RequestInit = {}) {
    const res = await fetch(`${this.baseApi}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        ...(init.headers || {}),
      } as any,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dataverse ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async listSolutionFlows() {
    const select = '$select=workflowid,name,category,statecode,clientdata';
    const filter = '$filter=category eq 5'; // modern cloud flows
    return this.request(`/workflows?${select}&${filter}`);
  }

  async getFlow(workflowId: string) {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    return this.request(`/workflows(${workflowId})?${select}`);
  }

  async getFlowByName(name: string) {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    const filter = `$filter=category eq 5 and name eq '${name.replace(/'/g, "''")}'`;
    const result = await this.request(`/workflows?${select}&${filter}&$top=1`);
    return result?.value?.[0] || null;
  }

  async patchFlow(workflowId: string, payload: Partial<{ clientdata: string; statecode: number; statuscode: number }>) {
    return this.request(`/workflows(${workflowId})`, {
      method: 'PATCH',
      headers: { 'If-Match': '*' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * List all modern cloud flows (category 5) in the environment.
   * Returns workflowid, name, description, statecode, and clientdata.
   */
  async listAllFlows() {
    const select = '$select=workflowid,name,description,category,statecode,clientdata';
    const filter = '$filter=category eq 5';
    const result = await this.request(`/workflows?${select}&${filter}&$orderby=name asc`);
    return result?.value || [];
  }

  /**
   * Get a solution by its unique name. Returns null if not found.
   */
  async getSolutionByUniqueName(uniqueName: string) {
    const filter = `$filter=uniquename eq '${uniqueName.replace(/'/g, "''")}'`;
    const result = await this.request(`/solutions?${filter}&$select=solutionid,uniquename,friendlyname&$top=1`);
    return result?.value?.[0] || null;
  }

  /**
   * List workflow IDs (component type 29) in a solution, then fetch their full records.
   */
  async listFlowsInSolution(solutionId: string) {
    // Step 1: get workflow component IDs from solution
    const components = await this.request(
      `/solutioncomponents?$filter=_solutionid_value eq ${solutionId} and componenttype eq 29&$select=objectid`
    );
    const ids: string[] = (components?.value || []).map((c: any) => c.objectid);
    if (ids.length === 0) return [];

    // Step 2: fetch workflows by IDs (batch in groups to avoid URL length limits)
    const batchSize = 50;
    const allFlows: any[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const filterConditions = batch.map(id => `workflowid eq ${id}`).join(' or ');
      const select = '$select=workflowid,name,description,category,statecode,clientdata';
      const result = await this.request(`/workflows?${select}&$filter=(${filterConditions})&$orderby=name asc`);
      allFlows.push(...(result?.value || []));
    }
    return allFlows;
  }

  async listConnectionReferences(): Promise<ConnectionReferenceRecord[]> {
    const select = '$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,statecode';
    const filter = '$filter=statecode eq 0'; // active only
    const result = await this.request(`/connectionreferences?${select}&${filter}&$orderby=connectionreferencedisplayname asc`);
    return result?.value || [];
  }
}

export default DataverseClient;

