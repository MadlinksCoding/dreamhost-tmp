FYI
Can it be used to block users / suspect users / warn users?



Yes — for blocking and warning — with a couple of important caveats.



✅ Block (different kinds)



BlockService supports multiple kinds of blocks:



User-to-user block (e.g., “A blocks B in chat”):



blockUser(from, to, scope, options)



unblockUser(from, to, scope)



isUserBlocked(from, to, scope)



batchCheckUserBlocks([...])



System/auth blocks (good for stopping signups/logins):



blockIP(ip, reason, permanent)



isIPBlocked(ip)



blockEmail(email, reason, permanent)



isEmailBlocked(email)



Block access to a specific part of the app (per-user, per-scope):



blockAppAccess(userId, scope, reason, permanent)



isAppAccessBlocked(userId, scope)



Suspend a user (this is your “system-wide block user” concept):



suspendUser(userId, reason, adminId, flag, note)



isUserSuspended(userId)



unsuspendUser(userId)



✅ Warn



It supports warnings via:



warnUser(userId, flagKey, adminId, note)



Warnings are stored in manual_actions and trigger notifyUser(...), but they don’t automatically block anything.



Susend User



Treat a warning (via warnUser) as “suspected” (especially using a flag like fraud, spam, etc.)



Add a new manual action type like type: "suspect" + a Redis key (similar to block:suspended:<userId>) and check it in your auth/middleware.



Important caveats in this ZIP (you’ll want to fix these)
1) All the is*Blocked() checks are Redis-only



Methods like isIPBlocked, isEmailBlocked, isAppAccessBlocked, isUserSuspended only check Redis.



So if Redis is flushed/restarted and not rehydrated, blocks may stop being enforced even though Scylla has records.



2) TTL / temporary blocks are effectively broken right now



BlockService.redisSet() calls:



RedisClass.set(key, value, ttl)



…but in reddis.js, RedisClass.set() expects an options object like { expiry: seconds }, not a number.



Result: temporary blocks won’t expire (they’ll be set without expiry).



A minimal fix is to change BlockService.redisSet() to pass { expiry: ttl } instead of ttl.



3) The table key schemas overwrite different “types/scopes”



From schema/schema.js:



system_blocks key is only identifier (so different type/scope entries can overwrite each other)



manual_actions key is only user_id (so multiple actions overwrite)



user_blocks key is blocker_id + blocked_id (so different scope blocks can overwrite)



Redis keys include scope/type, but the DB keys don’t — that mismatch can cause data loss in Scylla history.

Put into AI i think some shcema and logical issues

When writing tests suite we need to consider the above scenrious

Also note these susppension reasons:
create a private ststic function that has this data to be retreived based on flag. Flag Suspension Prefix Suspension Warning Action Text Redirect slug fraud Your Account is suspended due to potential fraudulent activities Contact Support support abuse Your Account will be suspended due to reported abusive behavior Contact Support support violence Your Account is suspended due to violence Contact Support support unacceptable_behavior Your Account is suspended due to unacceptable behavior Contact Support support exploitation Your Account is suspended due to exploitation 
- non-consensual media Contact Support support hate Your Account is suspended due to hateful activities Contact Support support harassment Your Account will be suspended due to harassment and criticism Contact Support support child_safety Your Account is suspended due to child safety Contact Support support self_injury Your Account is suspended due to self-injury or harmful behavior Contact Support support graphic_violence Your Account is suspended due to graphic violence or threats Contact Support support dangerous_activities Your Account is suspended due to dangerous activities Contact Support support impersonation Your Account will be suspended due to impersonation Contact Support support security Your Account is suspended due to site security and access Contact Support support spam Your Account will be suspended due to spam detection Contact Support support then a function to retrieve the text, slug - based on the flag, assume we are in a class