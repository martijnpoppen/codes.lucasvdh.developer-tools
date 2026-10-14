"use strict";
import {Driver, FlowCardTriggerDevice} from "homey";
import AthomApi, {AppData} from "../../lib/AthomApi";
import PatStore, {PatEntry} from "../../lib/PatStore";

/**
 * One device per account (Personal Access Token) with the total installs and
 * the installs of every app of that account. The app driver already fetches
 * the apps of every token on each poll and hands them over through
 * onAppsUpdated, so this driver does not poll the API itself.
 */
class OverviewDriver extends Driver {
  private latestAppsByPatId: Map<string, AppData[]> = new Map();
  installsIncreasedTrigger?: FlowCardTriggerDevice;
  installsDecreasedTrigger?: FlowCardTriggerDevice;

  async onInit() {
    this.installsIncreasedTrigger = this.homey.flow.getDeviceTriggerCard('overview_installs_increased');
    this.installsDecreasedTrigger = this.homey.flow.getDeviceTriggerCard('overview_installs_decreased');
    this.log('App overview driver has been initialized');
  }

  getPatStore(): PatStore {
    return new PatStore(this.homey.settings);
  }

  static ownerLabelFor(entry: PatEntry): string {
    return entry.label || entry.username || entry.email || `Account ${entry.id.slice(0, 6)}`;
  }

  /** Called by the app driver after every poll. */
  async onAppsUpdated(appsByPatId: Map<string, AppData[]>): Promise<void> {
    this.latestAppsByPatId = new Map(appsByPatId);
    for (const device of this.getDevices()) {
      try {
        await (device as any).onAppsUpdated(appsByPatId);
      } catch (e) {
        this.error(e);
      }
    }
  }

  /** Apps of one token: from the last poll, or fetched once if there is none yet (e.g. right after pairing). */
  async getApps(patId: string): Promise<AppData[] | undefined> {
    const cached = this.latestAppsByPatId.get(patId);
    if (cached) return cached;

    const entry = this.getPatStore().get(patId);
    if (!entry) return undefined;
    const apps = await new AthomApi(entry.token).getApps();
    this.latestAppsByPatId.set(patId, apps);
    return apps;
  }

  async onPair(session: any) {
    session.setHandler('showView', async (view: string) => {
      if (view === 'loading') {
        await session.showView(this.getPatStore().list().length > 0 ? 'list_devices' : 'not_configured');
      }
    });

    session.setHandler('list_devices', async () => {
      return this.getPatStore().list().map((entry) => ({
        name: `${this.homey.__('overview.device_name')} - ${OverviewDriver.ownerLabelFor(entry)}`,
        // The account id survives replacing the token; the token id is the fallback.
        data: {id: `overview-${entry.userId || entry.id}`},
        // Homey reads `store` (not `storage`) when the device is added.
        store: {id: entry.userId || entry.id, pat_id: entry.id},
      }));
    });
  }
}

module.exports = OverviewDriver;
