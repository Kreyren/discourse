import EmberObject from "@ember/object";
import { ajax } from "discourse/lib/ajax";
import { on } from "discourse-common/utils/decorators";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { deepEqual, deepMerge } from "discourse-common/lib/object";
import {
  ARCHIVE_FILTER,
  INBOX_FILTER,
  NEW_FILTER,
  UNREAD_FILTER,
} from "discourse/routes/build-private-messages-route";
import { NotificationLevels } from "discourse/lib/notification-levels";

// See private_message_topic_tracking_state.rb for documentation
const PrivateMessageTopicTrackingState = EmberObject.extend({
  CHANNEL_PREFIX: "/private-message-topic-tracking-state",

  inbox: null,
  filter: null,
  activeGroup: null,

  @on("init")
  _setup() {
    this.states = new Map();
    this.statesModificationCounter = 0;
    this.isTracking = false;
    this.newIncoming = [];
  },

  startTracking() {
    if (this.isTracking) {
      return;
    }

    this._establishChannels();

    this._loadInitialState().finally(() => {
      this.set("isTracking", true);
    });
  },

  _establishChannels() {
    this.messageBus.subscribe(
      this._userChannel(),
      this._processMessage.bind(this)
    );

    this.currentUser.groupsWithMessages?.forEach((group) => {
      this.messageBus.subscribe(
        this._groupChannel(group.id),
        this._processMessage.bind(this)
      );
    });
  },

  lookupCount(type, opts = {}) {
    const typeFilterFn = type === "new" ? this._isNew : this._isUnread;
    const inbox = opts.inboxFilter || this.inbox;
    let filterFn;

    if (inbox === "user") {
      filterFn = this._isPersonal.bind(this);
    } else if (inbox === "group") {
      filterFn = this._isGroup.bind(this);
    }

    return Array.from(this.states.values()).filter((topic) => {
      return (
        typeFilterFn(topic) && (!filterFn || filterFn(topic, opts.groupName))
      );
    }).length;
  },

  trackIncoming(inbox, filter, group) {
    this.setProperties({ inbox, filter, activeGroup: group });
  },

  resetIncomingTracking() {
    if (this.inbox) {
      this.set("newIncoming", []);
    }
  },

  removeTopics(topicIds) {
    if (!this.isTracking) {
      return;
    }

    topicIds.forEach((topicId) => this.states.delete(topicId));
    this.incrementProperty("statesModificationCounter");
  },

  _userChannel() {
    return `${this.CHANNEL_PREFIX}/user/${this.currentUser.id}`;
  },

  _groupChannel(groupId) {
    return `${this.CHANNEL_PREFIX}/group/${groupId}`;
  },

  _isNew(topic) {
    return (
      !topic.last_read_post_number &&
      ((topic.notification_level !== 0 && !topic.notification_level) ||
        topic.notification_level >= NotificationLevels.TRACKING) &&
      !topic.is_seen
    );
  },

  _isUnread(topic) {
    return (
      topic.last_read_post_number &&
      topic.last_read_post_number < topic.highest_post_number &&
      topic.notification_level >= NotificationLevels.TRACKING
    );
  },

  _isPersonal(topic) {
    const groups = this.currentUser?.groups;

    if (!groups || groups.length === 0) {
      return true;
    }

    return !groups.some((group) => {
      return topic.group_ids?.includes(group.id);
    });
  },

  _isGroup(topic, activeGroupName) {
    return this.currentUser.groups.some((group) => {
      return (
        group.name === (activeGroupName || this.activeGroup.name) &&
        topic.group_ids?.includes(group.id)
      );
    });
  },

  _processMessage(message) {
    switch (message.message_type) {
      case "new_topic":
        this._modifyState(message.topic_id, message.payload);

        if (
          [NEW_FILTER, INBOX_FILTER].includes(this.filter) &&
          this._shouldDisplayMessageForInbox(message)
        ) {
          this._notifyIncoming(message.topic_id);
        }

        break;
      case "read":
        this._modifyState(message.topic_id, message.payload);

        if (
          this.filter === UNREAD_FILTER &&
          this._shouldDisplayMessageForInbox(message)
        ) {
          this._notifyIncoming(message.topic_id);
        }
      case "unread":
        this._modifyState(message.topic_id, message.payload);

        if (
          [UNREAD_FILTER, INBOX_FILTER].includes(this.filter) &&
          this._shouldDisplayMessageForInbox(message)
        ) {
          this._notifyIncoming(message.topic_id);
        }

        break;
      case "archive":
        if (
          [INBOX_FILTER, ARCHIVE_FILTER].includes(this.filter) &&
          ["user", "all"].includes(this.inbox)
        ) {
          this._notifyIncoming(message.topic_id);
        }
        break;
      case "group_archive":
        if (
          [INBOX_FILTER, ARCHIVE_FILTER].includes(this.filter) &&
          (this.inbox === "all" || this._displayMessageForGroupInbox(message))
        ) {
          this._notifyIncoming(message.topic_id);
        }
    }
  },

  _displayMessageForGroupInbox(message) {
    return (
      this.inbox === "group" &&
      message.payload.group_ids.includes(this.activeGroup.id)
    );
  },

  _shouldDisplayMessageForInbox(message) {
    return (
      this.inbox === "all" ||
      this._displayMessageForGroupInbox(message) ||
      (this.inbox === "user" &&
        (message.payload.group_ids.length === 0 ||
          this.currentUser.groups.filter((group) => {
            return message.payload.group_ids.includes(group.id);
          }).length === 0))
    );
  },

  _notifyIncoming(topicId) {
    if (this.newIncoming.indexOf(topicId) === -1) {
      this.newIncoming.pushObject(topicId);
    }
  },

  _loadInitialState() {
    return ajax(
      `/u/${this.currentUser.username}/private-message-topic-tracking-state`
    )
      .then((pmTopicTrackingStateData) => {
        pmTopicTrackingStateData.forEach((topic) => {
          this._modifyState(topic.topic_id, topic, { skipIncrement: true });
        });
      })
      .catch(popupAjaxError);
  },

  _modifyState(topicId, data, opts = {}) {
    const oldState = this.states.get(topicId);
    let newState = data;

    if (oldState && !deepEqual(oldState, newState)) {
      newState = deepMerge(oldState, newState);
    }

    this.states.set(topicId, newState);

    if (!opts.skipIncrement) {
      this.incrementProperty("statesModificationCounter");
    }
  },
});

export default PrivateMessageTopicTrackingState;
