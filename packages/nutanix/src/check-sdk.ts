import type { UsersApi, AuthorizationPoliciesApi, RolesApi } from '@nutanix-api/iam-js-client';
import type { VmApi, ImagesApi } from '@nutanix-api/vmm-js-client';
import type { CategoriesApi } from '@nutanix-api/prism-js-client';
import type { SubnetsApi, VpcsApi } from '@nutanix-api/networking-js-client';
import type { NetworkSecurityPoliciesApi, ServiceGroupsApi } from '@nutanix-api/microseg-js-client';
import type { StoragePoliciesApi, ProtectionPoliciesApi } from '@nutanix-api/datapolicies-js-client';
import type { ApprovalPoliciesApi } from '@nutanix-api/security-js-client';
import type { ReportConfigApi } from '@nutanix-api/opsmgmt-js-client';

// Generated declarations mark optional query fields as required. Calls accept subsets.
type ListApi<T, K extends keyof T> = {
  [P in K]: T[P] extends (opts: infer O, ...args: any[]) => unknown
    ? (opts: Partial<O>) => Promise<unknown> : never;
};

export interface NutanixCheckSdk {
  iam: {
    users: ListApi<UsersApi, 'listUsers'>;
    authzPolicies: ListApi<AuthorizationPoliciesApi, 'listAuthorizationPolicies'>;
    roles: ListApi<RolesApi, 'listRoles'>;
  };
  vmm: {
    vms: ListApi<VmApi, 'listVms'>;
    images: ListApi<ImagesApi, 'listImages'>;
  };
  prism: {
    categories: ListApi<CategoriesApi, 'listCategories'>;
  };
  networking: {
    subnets: ListApi<SubnetsApi, 'listSubnets'>;
    vpcs: ListApi<VpcsApi, 'listVpcs'>;
  };
  microseg: {
    policies: ListApi<NetworkSecurityPoliciesApi, 'listNetworkSecurityPolicies'> & Pick<NetworkSecurityPoliciesApi, 'getNetworkSecurityPolicyById'>;
    serviceGroups: ListApi<ServiceGroupsApi, 'listServiceGroups'>;
  };
  datapolicies: {
    storage: ListApi<StoragePoliciesApi, 'listStoragePolicies'>;
    protection: ListApi<ProtectionPoliciesApi, 'listProtectionPolicies'>;
  };
  security: {
    approvals: ListApi<ApprovalPoliciesApi, 'listApprovalPolicies'>;
  };
  opsmgmt: {
    reportConfigs: ListApi<ReportConfigApi, 'listReportConfigs'>;
  };
}
