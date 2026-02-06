import Users from "../service/Users.js";

export default async function testIsUsernameTaken() {
  const result = await Users.isUsernameTaken("delish");

  console.log("result", result);
}
testIsUsernameTaken();
