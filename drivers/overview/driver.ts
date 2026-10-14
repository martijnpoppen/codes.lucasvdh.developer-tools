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
interface OrganizationChoice {
  id: string;
  name: string;
}

interface AccountChoice {
  patId: string;
  accountId: string;
  name: string;
  organizations: OrganizationChoice[];
}

class OverviewDriver extends Driver {
  private latestAppsByPatId: Map<string, AppData[]> = new Map();
  private apis: Map<string, AthomApi> = new Map();
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

  /** An API client per token, reused so its delegation token is cached. */
  getApi(patId: string): AthomApi | undefined {
    const entry = this.getPatStore().get(patId);
    if (!entry) return undefined;
    let api = this.apis.get(patId);
    if (!api) {
      api = new AthomApi(entry.token);
      this.apis.set(patId, api);
    } else {
      api.setPersonalAccessToken(entry.token);
    }
    return api;
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

  /**
   * The accounts (tokens) with the Developer Organizations each one belongs
   * to, for the selection screen in pairing and repair.
   */
  private async listAccounts(patIds?: string[]): Promise<AccountChoice[]> {
    const accounts: AccountChoice[] = [];
    const seen = new Set<string>();
    for (const entry of this.getPatStore().list()) {
      if (patIds && !patIds.includes(entry.id)) continue;
      // The account id survives replacing the token; the token id is the fallback.
      const accountId = entry.userId || entry.id;
      if (seen.has(accountId)) continue;
      seen.add(accountId);

      let organizations: OrganizationChoice[] = [];
      try {
        organizations = (await new AthomApi(entry.token).getOrganizations())
            .filter((organization) => organization?.id)
            .map((organization) => ({id: organization.id, name: organization.name || organization.id}));
      } catch (e) {
        this.error(`Could not list the organizations of token ${entry.id.slice(0, 6)}`, e);
      }
      accounts.push({patId: entry.id, accountId, name: OverviewDriver.ownerLabelFor(entry), organizations});
    }
    return accounts;
  }

  /** Whether an overview device for this account (or its token) already exists. */
  private hasOverviewFor(account: AccountChoice): boolean {
    return this.getDevices().some((device) => {
      const dataId = device.getData().id;
      return dataId === `overview-${account.accountId}`
          || dataId === `overview-${account.patId}`
          || device.getStoreValue('pat_id') === account.patId;
    });
  }

  async onPair(session: any) {
    let selection: Array<{data: {id: string}, store: {pat_id: string}}> = [];

    session.setHandler('showView', async (view: string) => {
      if (view === 'loading') {
        await session.showView(this.getPatStore().list().length > 0 ? 'list_devices' : 'not_configured');
      }
    });

    // Step 1: Homey's own device list, one device per account. Accounts that
    // already have an overview device are left out.
    session.setHandler('list_devices', async () => {
      const accounts = (await this.listAccounts()).filter((account) => !this.hasOverviewFor(account));
      return accounts.map((account) => ({
        name: `${this.homey.__('overview.device_name')} - ${account.name}`,
        data: {id: `overview-${account.accountId}`},
        // Homey reads `store` (not `storage`) when the device is added.
        store: {id: account.accountId, pat_id: account.patId, organization_ids: []},
      }));
    });

    session.setHandler('list_devices_selection', async (devices: typeof selection) => {
      selection = Array.isArray(devices) ? devices : [];
    });

    // Step 2: the organizations of the selected accounts.
    session.setHandler('get_accounts', async () => {
      const accounts = await this.listAccounts(selection.map((device) => device.store?.pat_id));
      return {accounts};
    });

    // The selected devices with the chosen organizations; the screen adds them.
    session.setHandler('build_devices', async (choices: Array<{patId: string, organizationIds: string[]}>) => {
      const accounts = await this.listAccounts(selection.map((device) => device.store?.pat_id));
      return selection.map((device) => {
        const account = accounts.find((item) => item.patId === device.store?.pat_id);
        const choice = choices.find((item) => item.patId === device.store?.pat_id);
        const organizationIds = (choice?.organizationIds ?? [])
            .filter((id) => account?.organizations.some((organization) => organization.id === id));
        return {...device, store: {...device.store, organization_ids: organizationIds}};
      });
    });
  }

  async onRepair(session: any, device: any) {
    session.setHandler('get_accounts', async () => {
      const patId = device.getStoreValue('pat_id');
      const accounts = await this.listAccounts(patId ? [patId] : undefined);
      return {accounts: accounts.slice(0, 1), selected: device.getOrganizationIds()};
    });

    session.setHandler('save_organizations', async (organizationIds: string[]) => {
      await device.setOrganizationIds(Array.isArray(organizationIds) ? organizationIds : []);
      return true;
    });
  }
}

module.exports = OverviewDriver;
