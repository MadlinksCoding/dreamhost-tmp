import Users from "../service/Users.js";

export default async function testPresenceStatus() {
  console.log(await Users.getOnlineStatus("u1"));

  //   Batch
  console.log("batch", await Users.getBatchOnlineStatus(["u1", "u2"]));

  // Invalid
  console.log(await Users.getOnlineStatus(""));
}
testPresenceStatus();
