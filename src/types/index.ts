export interface CDNMapping {
  [key: string]: string;
}

export interface DependencyInfo {
  name: string;
  version: string;
  url: string;
  content: string;
  dependencies: DependencyInfo[];
}

export interface DependencyManifest {
  timestamp: string;
  dependencies: Array<{
    name: string;
    version: string;
    url: string;
    hasNestedDependencies: boolean;
    nestedCount: number;
  }>;
}

export interface InterceptionStats {
  intercepted: number;
  cached: number;
  requests: Array<{
    url: string;
    timestamp: number;
    served: boolean;
  }>;
}

export interface ExtensionStorage {
  cdnMappings: CDNMapping;
  dependencyManifest: DependencyManifest;
  stats: InterceptionStats;
}