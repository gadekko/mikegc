"use client";

import { IntakeFeatureSetting } from "@/app/components/intake/IntakeSettings";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { useOrganizationSettings } from "./OrganizationSettingsShell";

/** Switch organization-wide features on or off. Owners only. */
export function OrganizationFeaturesSettings() {
  const { orgId } = useOrganizationSettings();
  return (
    <section aria-labelledby="org-features" className="space-y-3">
      <SettingsHeading id="org-features">Features</SettingsHeading>
      <GlassCardUI>
        <IntakeFeatureSetting orgId={orgId} />
      </GlassCardUI>
    </section>
  );
}
