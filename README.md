# DragonMail

DragonMail is a email server made entirely from scratch (no not Scratch 3) where you can host a email without worrying about setting up a DNS record for MX just use the A record.

**_How is this possible?_**

- When a user requests a mail to be sent over the server looks at "bob@example.com" using @ to split the values into an array.
- Then the server stores the request into a requestBox array for processing.
- After that the server asks the other server using a ASK_PORT which is a UDP protocol listening to port 100 a question {"id":"ASKINFO"} which the other server will either respond with the answer telling the server it's name + if it's ssl or not otherwise the server destroys the request if there's no response within 15 seconds.
- Once everything's sent the request gets destroyed for the next request.

# How do you set it up?

1. Install the dependencies by using `npm install` or if node is missing download NodeJS.
2. Start the server by using `node server.js`.
3. Kill the program by either Ctrl+C or through the task manager.
4. Edit `config.json` and modify the `domain_root` to match with your domain. If you want SSL specify the `cert` and `key_cert` you must specify their paths.
5. After that save and re-run the program again. The server should listen to a port in the config.