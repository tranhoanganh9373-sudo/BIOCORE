// 通用页面标题区 — 统一二级页面 header 风格
// 用法:
//   <PageHeader icon={BookOpen} title="配方管理" subtitle="..." right={<Badge>1</Badge>} />
'use client';

import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface PageHeaderProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, right }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 text-foreground">
          {Icon && <Icon className="w-5 h-5 text-primary" />}
          {title}
        </h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}
