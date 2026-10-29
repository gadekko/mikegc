"use client";
import { useEffect, useState } from "react";
import { getIntakeConfiguration } from "@/app/lib/mikeApi";
/** Discover configured intake for the current workspace and refresh when focus returns. */
export function useIntakeNavigation(accountId: string | null, orgId?: string) {
  const key = `${accountId}:${orgId}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    visible: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (!accountId || !orgId) return;
    const refresh = () => {
      void getIntakeConfiguration(orgId)
        .then((c) => {
          if (active) setLoaded({ key, visible: c.enabled });
        })
        .catch(() => {
          // Navigation is optional discovery. The settings page reports load errors.
          if (active) setLoaded({ key, visible: false });
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("mike:intake-configured", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("mike:intake-configured", refresh);
    };
  }, [accountId, orgId, key]);
  return loaded?.key === key && loaded.visible;
}
